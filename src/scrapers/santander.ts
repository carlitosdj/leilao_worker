/**
 * Scraper — Santander Imóveis (santanderimoveis.com.br)
 *
 * Portal de imóveis retomados do Santander (venda direta + leilão).
 *
 * Estratégia:
 * 1. GET /?s=uberlandia&post_type=imovel → cookie Akamai (ak_bmsc) + slugs dos imóveis
 * 2. Para cada slug: GET /venda/imovel/{slug}/ com Cookie + Referer
 * 3. Parse HTML: endereço, CEP, valores, área, imagens
 *
 * Nota WAF: Akamai bloqueia Playwright headless mas permite axios com headers
 * de navegador completos. O cookie ak_bmsc obtido na primeira request é essencial
 * para acessar as páginas de detalhe.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { ImovelRaw, ScraperResult } from './types';

const BASE_URL = 'https://www.santanderimoveis.com.br';
const SEARCH_URL = `${BASE_URL}/?s=uberlandia&post_type=imovel`;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Cache-Control': 'max-age=0',
};

const http = axios.create({ timeout: 30000, decompress: true });

// ── utilidades ────────────────────────────────────────────────

function extrairCookies(headers: Record<string, any>): string {
  const raw: string[] = Array.isArray(headers['set-cookie'])
    ? headers['set-cookie']
    : headers['set-cookie'] ? [headers['set-cookie']] : [];
  return raw.map(c => c.split(';')[0]).join('; ');
}

function extrairValor(texto: string): number {
  const limpo = texto.replace(/\./g, '').replace(',', '.');
  const m = limpo.match(/[\d]+\.?\d*/);
  return m ? parseFloat(m[0]) : 0;
}

function normalizarTipo(titulo: string): ImovelRaw['tipo'] {
  const t = titulo.toLowerCase();
  if (t.includes('apart') || t.includes('apto') || t.includes('kitnet') || t.includes('flat') || t.includes('studio')) return 'apartamento';
  if (t.includes('casa') || t.includes('sobrado') || t.includes('chácara') || t.includes('chacara') || t.includes('residenci')) return 'casa';
  if (t.includes('terreno') || t.includes('lote') || t.includes('gleba')) return 'terreno';
  if (t.includes('comercial') || t.includes('sala') || t.includes('loja') || t.includes('galpão') || t.includes('galpao') || t.includes('prédio') || t.includes('predio')) return 'comercial';
  if (t.includes('rural') || t.includes('sítio') || t.includes('sitio') || t.includes('fazenda')) return 'rural';
  return 'outro';
}

// ── parse da listagem ─────────────────────────────────────────

function extrairSlugs(html: string): string[] {
  const $ = cheerio.load(html);
  const slugs = new Set<string>();

  // Links em tags <a> e <h1>
  $('a[href*="/venda/imovel/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/\/venda\/imovel\/([a-z0-9\-]+)/);
    if (m) slugs.add(m[1]);
  });

  // Fallback: regex no HTML bruto (usado quando links estão como texto)
  const matches = html.match(/\/venda\/imovel\/([a-z0-9\-]+)/g) || [];
  for (const m of matches) {
    const s = m.replace('/venda/imovel/', '');
    if (s) slugs.add(s);
  }

  // Filtrar apenas imóveis de Uberlândia (excluir "passos-mg", etc.)
  return [...slugs].filter(s => s.includes('uberlandia-mg'));
}

// ── parse do detalhe ──────────────────────────────────────────

interface DetalheInfo {
  codigo: string;
  endereco?: string;
  bairro?: string;
  cep?: string;
  valorAvaliacao: number;
  valorVenda: number;
  areaTerreno?: number;
  areaConstruida?: number;
  ocupado: ImovelRaw['ocupado'];
  imagens: string[];
  dataLeilao?: Date;
  modalidade: ImovelRaw['modalidade'];
}

function parsearDetalhe(html: string): DetalheInfo | null {
  const $ = cheerio.load(html);

  // Detectar se está indisponível
  const textoCompleto = $('body').text();
  if (textoCompleto.includes('Imóvel Indisponível') || textoCompleto.includes('Imovel Indisponivel')) {
    return null;
  }

  // Código
  const codigoMatch = textoCompleto.match(/Cód\.\s*([\d.]+)/);
  const codigo = codigoMatch ? codigoMatch[1] : '';

  // Endereço: formato "Rua X, 50, Bairro, Cidade - UF. CEP: XXXXXXXX"
  // ou pode ter variações
  let endereco: string | undefined;
  let bairro: string | undefined;
  let cep: string | undefined;

  // CEP
  const cepMatch = textoCompleto.match(/CEP:\s*(\d{5}-?\d{3}|\d{8})/);
  if (cepMatch) cep = cepMatch[1].replace(/[-\s]/g, '');

  // Endereço: linha que contém a rua antes do CEP
  const endMatch = textoCompleto.match(/([A-ZÁÉÍÓÚÃÕÇÂÊÔÜ][^,\n]{3,}(?:,\s*\d+[^,\n]*)?),\s*([^,\n]+),\s*Uberlândia\s*[-–]\s*MG/i);
  if (endMatch) {
    endereco = endMatch[1].trim();
    bairro = endMatch[2].trim();
  } else {
    // Fallback: regex mais simples
    const endSimples = textoCompleto.match(/((?:Rua|Av(?:enida)?|Alameda|Travessa|Estrada|Rodovia|Rod\.)\s+[^,\n]+(?:,\s*\d+)?)/i);
    if (endSimples) endereco = endSimples[1].trim();
  }

  // Valores monetários
  // "Valor avaliado R$ X.XXX" e "Valor de venda A partir de R$ X.XXX" ou "Valor de venda R$ X.XXX"
  let valorAvaliacao = 0;
  let valorVenda = 0;

  const avalMatch = textoCompleto.match(/Valor\s+avaliado\s+R\$\s*([\d.,]+)/i);
  if (avalMatch) valorAvaliacao = extrairValor(avalMatch[1]);

  const vendaMatch = textoCompleto.match(/Valor\s+de\s+venda\s+(?:A\s+partir\s+de\s+)?R\$\s*([\d.,]+)/i);
  if (vendaMatch) valorVenda = extrairValor(vendaMatch[1]);

  // Lance mínimo (para caso seja leilão)
  const lanceMatch = textoCompleto.match(/Lance\s+m[ií]nimo\s+R\$\s*([\d.,]+)/i);
  if (lanceMatch && valorVenda === 0) valorVenda = extrairValor(lanceMatch[1]);

  // Área
  let areaTerreno: number | undefined;
  let areaConstruida: number | undefined;

  const areaT = textoCompleto.match(/(\d[\d.,]*)\s*m[²2]\s*de\s*[aá]rea\s+terreno/i);
  if (areaT) {
    areaTerreno = parseFloat(areaT[1].replace('.', '').replace(',', '.'));
    if (isNaN(areaTerreno)) areaTerreno = undefined;
  }
  const areaC = textoCompleto.match(/(\d[\d.,]*)\s*m[²2]\s*de\s*[aá]rea\s+constru[ií]da/i);
  if (areaC) {
    areaConstruida = parseFloat(areaC[1].replace('.', '').replace(',', '.'));
    if (isNaN(areaConstruida)) areaConstruida = undefined;
  }
  // Fallback: área total genérica
  if (!areaTerreno && !areaConstruida) {
    const areaGen = textoCompleto.match(/[Áá]rea(?:\s+total)?:?\s*([\d.,]+)\s*m[²2]/i);
    if (areaGen) {
      const v = parseFloat(areaGen[1].replace('.', '').replace(',', '.'));
      if (!isNaN(v)) areaTerreno = v;
    }
  }

  // Ocupado
  const ocupado: ImovelRaw['ocupado'] = textoCompleto.includes('Ocupado') ? 'sim' : 'nao';

  // Imagens (og:image + slides)
  const imagens: string[] = [];
  const ogImg = $('meta[property="og:image"]').attr('content');
  if (ogImg && ogImg.includes('wp-content/uploads')) imagens.push(ogImg);

  $('img[src*="wp-content/uploads"]').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (src && !imagens.includes(src)) imagens.push(src);
  });

  // Data do leilão
  let dataLeilao: Date | undefined;
  const dataMatch = textoCompleto.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (dataMatch) {
    const [, d, mo, a] = dataMatch;
    const dt = new Date(`${a}-${mo}-${d}`);
    if (!isNaN(dt.getTime()) && dt > new Date()) dataLeilao = dt;
  }

  // Modalidade: se tem "Aguardando data do leilão" ou "Lance" → licitacao, senão venda_direta
  const hasLeilao = textoCompleto.includes('data do leilão') || textoCompleto.includes('Lance mínimo');
  const modalidade: ImovelRaw['modalidade'] = hasLeilao ? 'licitacao' : 'venda_direta';

  return {
    codigo,
    endereco,
    bairro,
    cep,
    valorAvaliacao,
    valorVenda,
    areaTerreno,
    areaConstruida,
    ocupado,
    imagens,
    dataLeilao,
    modalidade,
  };
}

// ── scraper principal ─────────────────────────────────────────

export async function scraperSantander(): Promise<ScraperResult> {
  const imoveis: ImovelRaw[] = [];
  const erros: string[] = [];

  console.log('[Santander] Iniciando scraper...');
  console.log('[Santander] ── MG / UBERLANDIA ──────────────────');

  try {
    // 1. Busca: obter cookie Akamai + lista de slugs
    console.log('[Santander] Obtendo lista de imóveis...');
    const searchResp = await http.get(SEARCH_URL, { headers: BROWSER_HEADERS });
    const sessionCookie = extrairCookies(searchResp.headers as Record<string, any>);

    const slugs = extrairSlugs(searchResp.data as string);
    console.log(`[Santander] ${slugs.length} imóveis encontrados`);

    if (slugs.length === 0) {
      erros.push('[Santander] Nenhum slug encontrado na busca');
      return { imoveis, erros };
    }

    const detailHeaders = {
      ...BROWSER_HEADERS,
      'Referer': SEARCH_URL,
      'Sec-Fetch-Site': 'same-origin',
      'Cookie': sessionCookie,
    };

    // 2. Detalhe de cada imóvel
    for (const slug of slugs) {
      await new Promise(r => setTimeout(r, 1500));
      const url = `${BASE_URL}/venda/imovel/${slug}/`;

      try {
        const resp = await http.get(url, { headers: detailHeaders });
        const det = parsearDetalhe(resp.data as string);

        if (!det) {
          console.log(`  [skip] ${slug} — Indisponível`);
          continue;
        }

        // Extrair tipo do slug
        const tipo = normalizarTipo(slug);

        // codigoFonte: usar código da página ou o slug como fallback
        const codigoFonte = `santander-${det.codigo || slug}`;

        // Área preferida: construída se disponível, senão terreno
        const areaTotal = det.areaConstruida || det.areaTerreno;

        const valorMinimo = det.valorVenda > 0 ? det.valorVenda : det.valorAvaliacao;
        const valorAvaliacao = det.valorAvaliacao > 0 ? det.valorAvaliacao : valorMinimo;

        const im: ImovelRaw = {
          codigoFonte,
          urlFonte: url,
          tipo,
          modalidade: det.modalidade,
          estado: 'MG',
          cidade: 'Uberlândia',
          bairro: det.bairro,
          endereco: det.endereco,
          cep: det.cep,
          valorAvaliacao,
          valorMinimo,
          areaTotal,
          ocupado: det.ocupado,
          imagens: det.imagens,
          dataLeilao: det.dataLeilao,
        };

        imoveis.push(im);

        const desconto = valorAvaliacao > 0
          ? ((valorAvaliacao - valorMinimo) / valorAvaliacao * 100).toFixed(1)
          : '0.0';
        console.log(`  ✓ ${tipo} | ${det.bairro || 'Uberlândia'} | av: R$${valorAvaliacao.toLocaleString('pt-BR')} | mín: R$${valorMinimo.toLocaleString('pt-BR')} | ${desconto}% desc`);
      } catch (err: any) {
        const msg = `[Santander] Erro no detalhe ${slug}: ${err.message}`;
        console.error(msg);
        erros.push(msg);
      }
    }
  } catch (err: any) {
    const msg = `[Santander] Erro geral: ${err.message}`;
    console.error(msg);
    erros.push(msg);
  }

  console.log(`\n[Santander] Total: ${imoveis.length} imóveis, ${erros.length} erros`);
  return { imoveis, erros };
}
