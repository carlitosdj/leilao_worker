import http from 'http';
import path from 'path';
import { spawn } from 'child_process';

// ============================================================
// Servidor HTTP interno (só acessível na rede Docker leilao-network)
// Dispara o atualiza.ts como processo filho e transmite as linhas via SSE
//
//   GET  /status            → estado da execução atual/última
//   POST /atualizar         → inicia (409 se já estiver rodando)
//   GET  /atualizar/stream  → linhas já emitidas + novas, em tempo real
// ============================================================

const PORTA = Number(process.env.WORKER_PORT || 3403);
const MAX_LINHAS = 10000;

interface Execucao {
  id: number;
  origem: string;
  iniciadoEm: string;
  finalizadoEm: string | null;
  exitCode: number | null;
  linhas: string[];
}

let execucao: Execucao | null = null;
let proximoId = 1;
const ouvintes = new Set<http.ServerResponse>();

function rodando() {
  return execucao !== null && execucao.finalizadoEm === null;
}

function status() {
  if (!execucao) return { rodando: false, execucao: null };
  const { linhas, ...resto } = execucao;
  return { rodando: rodando(), execucao: { ...resto, totalLinhas: linhas.length } };
}

function enviar(res: http.ServerResponse, evento: object) {
  res.write(`data: ${JSON.stringify(evento)}\n\n`);
}

function emitirLinha(texto: string) {
  if (!execucao) return;
  execucao.linhas.push(texto);
  if (execucao.linhas.length > MAX_LINHAS) execucao.linhas.shift();
  for (const res of ouvintes) enviar(res, { tipo: 'linha', texto });
}

// Inicia o atualiza.ts (ts-node em dev, JS compilado em prod). Retorna false se já estiver rodando.
export function iniciarAtualizacao(origem: string): boolean {
  if (rodando()) return false;

  execucao = {
    id: proximoId++,
    origem,
    iniciadoEm: new Date().toISOString(),
    finalizadoEm: null,
    exitCode: null,
    linhas: [],
  };
  const atual = execucao;
  for (const res of ouvintes) enviar(res, { tipo: 'inicio', ...status() });

  const emTs = __filename.endsWith('.ts');
  const script = path.join(__dirname, emTs ? 'atualiza.ts' : 'atualiza.js');
  const args = emTs ? ['-r', 'ts-node/register', script] : [script];
  console.log(`[Worker] Atualização #${atual.id} iniciada (${origem})`);
  const filho = spawn(process.execPath, args, { cwd: process.cwd(), env: process.env });

  // Quebra a saída em linhas, repassando também para o log do container
  const lerSaida = (stream: NodeJS.ReadableStream, destino: NodeJS.WriteStream) => {
    let resto = '';
    stream.on('data', (chunk: Buffer) => {
      destino.write(chunk);
      const partes = (resto + chunk.toString()).split('\n');
      resto = partes.pop() ?? '';
      partes.forEach(emitirLinha);
    });
    stream.on('end', () => { if (resto) emitirLinha(resto); });
  };
  lerSaida(filho.stdout, process.stdout);
  lerSaida(filho.stderr, process.stderr);

  const finalizar = (exitCode: number) => {
    if (atual.finalizadoEm) return;
    atual.finalizadoEm = new Date().toISOString();
    atual.exitCode = exitCode;
    console.log(`[Worker] Atualização #${atual.id} finalizada (código ${exitCode})`);
    for (const res of ouvintes) {
      enviar(res, { tipo: 'fim', exitCode });
      res.end();
    }
    ouvintes.clear();
  };
  filho.on('error', err => { emitirLinha(`Erro ao iniciar atualização: ${err.message}`); finalizar(1); });
  filho.on('close', code => finalizar(code ?? 1));

  return true;
}

function json(res: http.ServerResponse, codigo: number, corpo: object) {
  res.writeHead(codigo, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(corpo));
}

function stream(req: http.IncomingMessage, res: http.ServerResponse) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  enviar(res, { tipo: 'inicio', ...status() });
  for (const texto of execucao?.linhas ?? []) enviar(res, { tipo: 'linha', texto });

  if (!rodando()) {
    if (execucao) enviar(res, { tipo: 'fim', exitCode: execucao.exitCode });
    res.end();
    return;
  }

  ouvintes.add(res);
  // Heartbeat: evita timeout de proxies/fetch em trechos sem saída
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  const sair = () => { clearInterval(heartbeat); ouvintes.delete(res); };
  res.on('close', sair);
  req.on('close', sair);
}

export function iniciarServidor() {
  const servidor = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];

    if (req.method === 'GET' && url === '/status') return json(res, 200, status());
    if (req.method === 'GET' && url === '/atualizar/stream') return stream(req, res);
    if (req.method === 'POST' && url === '/atualizar') {
      const iniciou = iniciarAtualizacao('manual');
      return json(res, iniciou ? 202 : 409, status());
    }
    json(res, 404, { error: 'Não encontrado' });
  });

  servidor.listen(PORTA, () => {
    console.log(`[Worker] Servidor interno ouvindo na porta ${PORTA}`);
  });
}
