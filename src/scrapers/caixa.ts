import axios from 'axios';
import * as cheerio from 'cheerio';
import { chromium, Page } from 'playwright';
import { ImovelRaw, ScraperResult } from './types';

const BASE_URL = 'https://venda-imoveis.caixa.gov.br';
const BUSCA_URL = `${BASE_URL}/sistema/busca-imovel.asp?sltTipoBusca=imoveis`;
const DETALHE_URL = `${BASE_URL}/sistema/detalhe-imovel.asp`;

// Prioridade: MG/Uberlândia primeiro
export const CIDADES_ALVO: Record<string, string[]> = {
  MG: ['UBERLANDIA', 'BELO HORIZONTE', 'CONTAGEM', 'JUIZ DE FORA'],
  SP: ['SAO PAULO', 'CAMPINAS', 'SANTOS', 'RIBEIRAO PRETO'],
  RJ: ['RIO DE JANEIRO', 'NITEROI'],
  RS: ['PORTO ALEGRE', 'CAXIAS DO SUL'],
  SC: ['FLORIANOPOLIS', 'JOINVILLE'],
  PR: ['CURITIBA', 'LONDRINA'],
  BA: ['SALVADOR'],
  CE: ['FORTALEZA'],
  GO: ['GOIANIA'],
  DF: ['BRASILIA'],
};

function normalizarTipo(texto: string): ImovelRaw['tipo'] {
  const t = texto.toLowerCase();
  if (t.includes('apart') || t.includes('apto') || t.includes('kitnet') || t.includes('flat')) return 'apartamento';
  if (t.includes('casa') || t.includes('sobrado') || t.includes('residência') || t.includes('chácara')) return 'casa';
  if (t.includes('terreno') || t.includes('lote') || t.includes('gleba')) return 'terreno';
  if (t.includes('comercial') || t.includes('sala') || t.includes('loja') || t.includes('galpão') || t.includes('pavilhão')) return 'comercial';
  if (t.includes('rural') || t.includes('sítio') || t.includes('fazenda') || t.includes('granja')) return 'rural';
  return 'outro';
}

function normalizarModalidade(texto: string): ImovelRaw['modalidade'] {
  const t = texto.toLowerCase();
  if (t.includes('2ª praça') || t.includes('2a praca') || t.includes('segunda praça') || t.includes('2º leilão') || t.includes('2o leilao')) return 'segundo_leilao';
  if (t.includes('1ª praça') || t.includes('1a praca') || t.includes('primeira praça') || t.includes('1º leilão') || t.includes('1o leilao')) return 'primeiro_leilao';
  if (t.includes('licitação') || t.includes('licitacao') || t.includes('licitação aberta')) return 'licitacao';
  if (t.includes('sfi') || t.includes('leilão sfi')) return 'primeiro_leilao';
  return 'venda_direta';
}

function extrairNumero(texto: string): number {
  const limpo = texto.replace(/\./g, '').replace(',', '.');
  const match = limpo.match(/[\d]+\.?\d*/);
  return match ? parseFloat(match[0]) : 0;
}

function extrairArea(texto: string): number | undefined {
  const match = texto.match(/([\d.,]+)\s*m[²2]/i);
  if (!match) return undefined;
  return parseFloat(match[1].replace('.', '').replace(',', '.'));
}

function extrairQuartos(texto: string): number | undefined {
  const match = texto.match(/(\d+)\s*(?:quarto|dorm)/i);
  return match ? parseInt(match[1]) : undefined;
}

function extrairVagas(texto: string): number | undefined {
  const match = texto.match(/(\d+)\s*vaga/i);
  return match ? parseInt(match[1]) : undefined;
}

// HTTP client para requests diretos (detail pages não precisam de browser)
const http = axios.create({
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': BUSCA_URL,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9',
  },
});

interface DetalheImovel {
  valorAvaliacao?: number;
  valorMinimo?: number;
  modalidade?: ImovelRaw['modalidade'];
  dataLeilao?: Date;
  ocupado?: ImovelRaw['ocupado'];
  cep?: string;
  imagens: string[];
}

async function buscarDetalhes(id: string, estado: string, cidadeId: string): Promise<DetalheImovel> {
  try {
    const params = new URLSearchParams({
      hdnimovel: id,
      hdn_estado: estado,
      hdn_cidade: cidadeId,
      hdn_modalidade: '',
      hdn_tp_imovel: '',
      hdn_quartos: '',
      hdn_vg_garagem: '',
      hdn_area_util: '',
      hdn_faixa_vlr: '',
      hdnorigem: 'buscaimovel',
      hdnValorSimulador: '',
      hdnAceitaFGTS: '',
      hdnAceitaFinanciamento: '',
      hdnSalvarDadosCliente: 'N',
    });

    const resp = await http.post(DETALHE_URL, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const $ = cheerio.load(resp.data);
    const texto = $('html').text();

    // Valor de avaliação
    let valorAvaliacao: number | undefined;
    const avMatch = texto.match(/[Vv]alor\s+de\s+avalia[çc][ãa]o[:\s]*R\$\s*([\d.,]+)/i);
    if (avMatch) valorAvaliacao = extrairNumero(avMatch[1]);

    // Valor mínimo — preferir 2º leilão; fallback 1º; fallback mínimo de venda
    let valorMinimo: number | undefined;
    const m2 = texto.match(/2[°º]\s*Leilão[^R]*R\$\s*([\d.,]+)/i)
             || texto.match(/mínimo.*2[°º].*?R\$\s*([\d.,]+)/i);
    const m1 = texto.match(/1[°º]\s*Leilão[^R]*R\$\s*([\d.,]+)/i)
             || texto.match(/mínimo.*1[°º].*?R\$\s*([\d.,]+)/i);
    const mv = texto.match(/[Vv]alor\s+m[ií]nimo[^R]*R\$\s*([\d.,]+)/i)
             || texto.match(/[Vv]enda[:\s]*R\$\s*([\d.,]+)/i);
    if (m2) valorMinimo = extrairNumero(m2[1]);
    else if (m1) valorMinimo = extrairNumero(m1[1]);
    else if (mv) valorMinimo = extrairNumero(mv[1]);

    // Modalidade
    let modalidade: ImovelRaw['modalidade'] = 'venda_direta';
    if (texto.match(/2[°º]\s*[Ll]eilão/)) modalidade = 'segundo_leilao';
    else if (texto.match(/1[°º]\s*[Ll]eilão/)) modalidade = 'primeiro_leilao';
    else if (texto.match(/[Ll]icita[çc][ãa]o/)) modalidade = 'licitacao';

    // Data do leilão
    let dataLeilao: Date | undefined;
    const dm = texto.match(/(\d{2}\/\d{2}\/\d{4})/);
    if (dm) {
      const [d, m, a] = dm[1].split('/');
      const dt = new Date(`${a}-${m}-${d}`);
      if (!isNaN(dt.getTime())) dataLeilao = dt;
    }

    // Ocupação
    let ocupado: ImovelRaw['ocupado'] = 'desconhecido';
    if (texto.match(/desocupado|livre\s*de\s*ocupa/i)) ocupado = 'nao';
    else if (texto.match(/\bocupado\b/i)) ocupado = 'sim';

    // CEP
    const cepM = texto.match(/CEP[:\s]*([\d]{5}-?[\d]{3})/i);
    const cep = cepM ? cepM[1] : undefined;

    // Imagens
    const imagens: string[] = [];
    $('img').each((_, el) => {
      const src = $(el).attr('src') || '';
      if (!src) return;
      const full = src.startsWith('http') ? src : `${BASE_URL}${src}`;
      if (
        (full.includes('/fotos/') || full.includes('.jpg') || full.includes('.jpeg')) &&
        !full.includes('semfoto') && !full.includes('logo') && !full.includes('icon')
      ) {
        imagens.push(full);
      }
    });

    return { valorAvaliacao, valorMinimo, modalidade, dataLeilao, ocupado, cep, imagens };
  } catch (err: any) {
    console.error(`  ! Erro detalhe ${id}: ${err.message}`);
    return { imagens: [] };
  }
}

interface ListItem {
  id: string;
  cidadeId: string;
  codigoFonte: string;
  textoBruto: string;
  imagemUrl: string;
  bairro: string;
  endereco: string;
  valorListagem: number;
  modalidadeTexto: string;
}

async function extrairItensLista(page: Page, estado: string, cidade: string): Promise<ListItem[]> {
  return page.evaluate(({ base, est, cid }: { base: string; est: string; cid: string }) => {
    const cards = document.querySelectorAll('#listaimoveispaginacao .group-block-item, li.group-block-item');
    const resultado: any[] = [];

    cards.forEach(card => {
      // ID da propriedade — está no onclick do img
      const img = card.querySelector('img') as HTMLImageElement | null;
      const onclickRaw = img?.getAttribute('onclick') || '';
      const idMatch = onclickRaw.match(/detalhe_imovel\((\d+)\)/);
      if (!idMatch) return;
      const id = idMatch[1];

      // Imagem thumbnail
      const imgSrc = img?.src || '';
      const imagemUrl = imgSrc.startsWith('http') ? imgSrc : imgSrc ? `${base}${imgSrc}` : '';

      // Modalidade (header do card)
      const headerSpan = card.querySelector('.fotoimovel-col1 strong') as HTMLElement | null;
      const modalidadeTexto = headerSpan?.innerText?.trim() || '';

      // Texto do corpo do card
      const col2 = card.querySelector('.dadosimovel-col2') as HTMLElement | null;
      const textoCompleto = col2?.innerText || (card as HTMLElement).innerText || '';

      // Bairro: "CIDADE - BAIRRO | R$ ..."
      let bairro = '';
      const bairroMatch = textoCompleto.match(/^\s*[A-ZÁÉÍÓÚ\s]+ - ([A-ZÁÉÍÓÚ\s\d]+?)\s*\|/m);
      if (bairroMatch) bairro = bairroMatch[1].trim();

      // Valor (mínimo da listagem)
      let valorListagem = 0;
      const valorMatch = textoCompleto.match(/R\$\s*([\d.,]+)/);
      if (valorMatch) {
        const v = valorMatch[1].replace(/\./g, '').replace(',', '.');
        valorListagem = parseFloat(v) || 0;
      }

      // Código fonte (número do imóvel)
      let codigoFonte = id;
      const codMatch = textoCompleto.match(/N[uú]mero do im[óo]vel[:\s]*([\w-]+)/i);
      if (codMatch) codigoFonte = codMatch[1].trim();

      // Endereço — linha após "Número do item: X"
      let endereco = '';
      const endMatch = textoCompleto.match(/N[uú]mero do item[:\s]*\d+\s*([^\n]+)/i);
      if (endMatch) endereco = endMatch[1].trim();

      // Cidade ID (hidden field já populado)
      const cidadeEl = document.querySelector('#hdn_cidade') as HTMLInputElement | null;
      const cidadeId = cidadeEl?.value || '';

      resultado.push({
        id,
        cidadeId,
        codigoFonte,
        textoBruto: textoCompleto.substring(0, 400),
        imagemUrl,
        bairro,
        endereco,
        valorListagem,
        modalidadeTexto,
      } as any);
    });

    return resultado;
  }, { base: BASE_URL, est: estado, cid: cidade });
}

async function scrapeEstadoCidade(page: Page, estado: string, cidade: string): Promise<ImovelRaw[]> {
  const imoveis: ImovelRaw[] = [];

  console.log(`\n[Caixa] ── ${estado} / ${cidade} ──────────────────`);
  await page.goto(BUSCA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // 1. Selecionar estado
  const temEstado = await page.evaluate((uf: string) => {
    const sel = document.querySelector('#cmb_estado') as HTMLSelectElement | null;
    if (!sel || !Array.from(sel.options).some(o => o.value === uf)) return false;
    sel.value = uf;
    (window as any).selecionaEstado?.();
    return true;
  }, estado);

  if (!temEstado) { console.log(`  Estado ${estado} não encontrado`); return []; }
  try { await page.waitForResponse(r => r.url().includes('carregaListaCidades') && r.status() === 200, { timeout: 8000 }); } catch {}
  await page.waitForTimeout(1000);

  // 2. Selecionar cidade
  const temCidade = await page.evaluate((nome: string) => {
    const sel = document.querySelector('#cmb_cidade') as HTMLSelectElement | null;
    if (!sel) return false;
    const opt = Array.from(sel.options).find(o => o.text.toUpperCase().includes(nome.toUpperCase()));
    if (!opt) return false;
    sel.value = opt.value;
    (window as any).carregaListaBairros?.();
    return true;
  }, cidade);

  if (!temCidade) { console.log(`  Cidade ${cidade} não encontrada`); return []; }
  try { await page.waitForResponse(r => r.url().includes('carregaListaBairros') && r.status() === 200, { timeout: 8000 }); } catch {}
  await page.waitForTimeout(800);

  // 3. Marcar todos os bairros
  const totalBairros = await page.evaluate(() => {
    const checks = document.querySelectorAll('#listabairros input[type="checkbox"]');
    checks.forEach((c: any) => { c.checked = true; });
    return checks.length;
  });
  console.log(`  ${totalBairros} bairros selecionados`);

  // 4. Clicar btn_next0 para popular hidden fields (hdn_cidade, hdn_bairro)
  await page.evaluate(() => { (document.querySelector('#btn_next0') as HTMLElement)?.click(); });
  await page.waitForTimeout(1500);

  const hdnCidade = await page.evaluate(() => (document.querySelector('#hdn_cidade') as HTMLInputElement)?.value || '');
  const hdnBairro = await page.evaluate(() => (document.querySelector('#hdn_bairro') as HTMLInputElement)?.value || '');

  if (!hdnCidade) { console.log(`  hdn_cidade não populado`); return []; }

  // 5. Definir filtros como Indiferente/Selecione
  await page.evaluate(() => {
    ['cmb_tp_imovel', 'cmb_quartos', 'cmb_vg_garagem', 'cmb_faixa_vlr', 'cmb_modalidade', 'cmb_financiamento'].forEach(id => {
      const sel = document.querySelector(`#${id}`) as HTMLSelectElement | null;
      if (!sel) return;
      const opt = Array.from(sel.options).find(o =>
        o.text.toLowerCase().includes('indiferente') || o.value === '' || o.text.toLowerCase().includes('selecione')
      );
      if (opt) sel.value = opt.value;
    });
  });
  await page.waitForTimeout(300);

  // 6. Limpar cache localStorage e disparar busca
  await page.evaluate(() => {
    localStorage.setItem('listaImoveis', '');
    localStorage.setItem('filtros', '');
  });

  const pesquisaPromise = page.waitForResponse(
    r => r.url().includes('carregaPesquisaImoveis') && r.status() === 200,
    { timeout: 30000 }
  ).catch(() => null);

  await page.evaluate(({ cid, bai }: { cid: string; bai: string }) => {
    (window as any).carregaPesquisaImoveis?.(cid, bai, '');
  }, { cid: hdnCidade, bai: hdnBairro });

  const pesquisaResp = await pesquisaPromise;
  if (!pesquisaResp) { console.log(`  Timeout em carregaPesquisaImoveis`); return []; }

  // carregaPesquisaImoveis chama internamente carregaListaImoveis(1)
  try {
    await page.waitForResponse(r => r.url().includes('carregaListaImoveis') && r.status() === 200, { timeout: 20000 });
  } catch {}
  await page.waitForTimeout(2000);

  // Ler total de páginas
  const paginacao = await page.evaluate(() => {
    const qtdPag = parseInt((document.querySelector('#hdnQtdPag') as HTMLInputElement)?.value || '1');
    const qtdReg = parseInt((document.querySelector('#hdnQtdRegistros') as HTMLInputElement)?.value || '0');
    return { qtdPag: isNaN(qtdPag) || qtdPag < 1 ? 1 : qtdPag, qtdReg: isNaN(qtdReg) ? 0 : qtdReg };
  });
  console.log(`  Total: ${paginacao.qtdReg} imóveis em ${paginacao.qtdPag} página(s)`);

  // 7. Iterar todas as páginas
  for (let pagina = 1; pagina <= paginacao.qtdPag; pagina++) {
    if (pagina > 1) {
      const listPromise = page.waitForResponse(
        r => r.url().includes('carregaListaImoveis') && r.status() === 200,
        { timeout: 15000 }
      ).catch(() => null);
      await page.evaluate((p: number) => { (window as any).carregaListaImoveis?.(p); }, pagina);
      await listPromise;
      await page.waitForTimeout(1500);
    }

    const itens = await extrairItensLista(page, estado, cidade);
    console.log(`  Página ${pagina}/${paginacao.qtdPag}: ${itens.length} itens`);

    // 8. Buscar detalhes de cada imóvel via HTTP POST
    for (const item of itens) {
      if (!item.id) continue;

      const det = await buscarDetalhes(item.id, estado, item.cidadeId || hdnCidade);

      const valorAvaliacao = det.valorAvaliacao || item.valorListagem;
      const valorMinimo    = det.valorMinimo    || item.valorListagem;

      if (valorAvaliacao === 0 && valorMinimo === 0) {
        console.log(`  ! Sem valores — ${item.codigoFonte}`);
        continue;
      }

      const nomeCidade = cidade.charAt(0).toUpperCase() + cidade.slice(1).toLowerCase();
      const urlFonte = `${BASE_URL}/sistema/detalhe-imovel.asp?hdnimovel=${item.id}`;

      const imovel: ImovelRaw = {
        codigoFonte:   item.codigoFonte,
        urlFonte,
        tipo:          normalizarTipo(item.textoBruto),
        modalidade:    det.modalidade || normalizarModalidade(item.modalidadeTexto + ' ' + item.textoBruto),
        estado,
        cidade:        nomeCidade,
        bairro:        item.bairro   || undefined,
        endereco:      item.endereco || undefined,
        cep:           det.cep       || undefined,
        valorAvaliacao,
        valorMinimo,
        areaTotal:     extrairArea(item.textoBruto),
        quartos:       extrairQuartos(item.textoBruto),
        vagas:         extrairVagas(item.textoBruto),
        ocupado:       det.ocupado   || 'desconhecido',
        dataLeilao:    det.dataLeilao,
        imagens:       det.imagens.length > 0 ? det.imagens : (item.imagemUrl ? [item.imagemUrl] : []),
      };

      imoveis.push(imovel);
      const desconto = valorAvaliacao > 0 ? ((valorAvaliacao - valorMinimo) / valorAvaliacao * 100).toFixed(1) : '0';
      console.log(`  ✓ ${imovel.tipo} | ${imovel.bairro || nomeCidade} | av: R$${valorAvaliacao.toLocaleString('pt-BR')} | mín: R$${valorMinimo.toLocaleString('pt-BR')} | ${desconto}% desc`);

      await new Promise(r => setTimeout(r, 300)); // pequeno delay entre requests
    }
  }

  return imoveis;
}

export async function scraperCaixa(alvos?: Record<string, string[]>): Promise<ScraperResult> {
  const targets = alvos || CIDADES_ALVO;
  const imoveis: ImovelRaw[] = [];
  const erros: string[] = [];

  console.log('[Caixa] Iniciando browser...');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--lang=pt-BR',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  for (const [est, cidades] of Object.entries(targets)) {
    for (const cid of cidades) {
      try {
        const resultado = await scrapeEstadoCidade(page, est, cid);
        imoveis.push(...resultado);
        console.log(`[Caixa] ${est}/${cid} → ${resultado.length} imóveis`);
      } catch (err: any) {
        const msg = `[Caixa] Erro em ${est}/${cid}: ${err.message}`;
        console.error(msg);
        erros.push(msg);
      }
      await page.waitForTimeout(2000);
    }
  }

  await browser.close();
  console.log(`\n[Caixa] Total: ${imoveis.length} imóveis coletados, ${erros.length} erros`);
  return { imoveis, erros };
}
