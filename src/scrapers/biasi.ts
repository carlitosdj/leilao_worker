/**
 * Scraper — Biasi Leilões (biasileiloes.com.br)
 *
 * Operador oficial do Itaú para leilões de imóveis retomados.
 *
 * Estratégia:
 * 1. GET /Sale/LotListSearch?estado=mg&cidade=uberlandia&... → HTML fragment com cards
 * 2. Para cada lote: GET /sale/detail?id={id} → endereço, avaliação, área, CEP, imagens
 * 3. Paginação via start = page * 48 até start >= total
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { ImovelRaw, ScraperResult } from './types';

const BASE_URL = 'https://www.biasileiloes.com.br';
const PAGE_SIZE = 48;

const http = axios.create({
  timeout: 30000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'pt-BR,pt;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': `${BASE_URL}/imoveis/mg/uberlandia/todos-os-bairros/todos-os-segmentos`,
  },
});

// ── normalizadores ────────────────────────────────────────────

function normalizarTipo(titulo: string): ImovelRaw['tipo'] {
  const t = titulo.toLowerCase();
  if (t.includes('apart') || t.includes('apto') || t.includes('kitnet') || t.includes('flat') || t.includes('studio')) return 'apartamento';
  if (t.includes('casa') || t.includes('sobrado') || t.includes('chácara') || t.includes('chacara') || t.includes('residencia') || t.includes('vila')) return 'casa';
  if (t.includes('terreno') || t.includes('lote') || t.includes('gleba') || t.includes('área')) return 'terreno';
  if (t.includes('comercial') || t.includes('sala') || t.includes('loja') || t.includes('galpão') || t.includes('galpao') || t.includes('prédio') || t.includes('predio')) return 'comercial';
  if (t.includes('rural') || t.includes('sítio') || t.includes('sitio') || t.includes('fazenda')) return 'rural';
  return 'outro';
}

function extrairValor(texto: string): number {
  const limpo = texto.replace(/\./g, '').replace(',', '.');
  const m = limpo.match(/[\d]+\.?\d*/);
  return m ? parseFloat(m[0]) : 0;
}

function normalizarModalidade(titulo: string, preco1: number, preco2: number): ImovelRaw['modalidade'] {
  const t = titulo.toLowerCase();
  if (t.includes('2º') || t.includes('2\u00ba') || t.includes('segundo')) return 'segundo_leilao';
  if (t.includes('1º') || t.includes('1\u00ba') || t.includes('primeiro')) return 'primeiro_leilao';
  if (t.includes('venda direta') || t.includes('extrajudicial')) return 'venda_direta';
  // Se há 2 preços, o segundo (menor) é do 2º leilão
  if (preco1 > 0 && preco2 > 0 && preco2 < preco1) return 'segundo_leilao';
  return 'licitacao';
}

// ── listagem ──────────────────────────────────────────────────

interface CardInfo {
  id: string;
  titulo: string;
  imagemUrl: string;
  preco1: number;
  preco2: number;
}

function parsearLista(html: string): { cards: CardInfo[]; total: number } {
  const $ = cheerio.load(html);
  const lista = $('#leilao-lista-lote');
  const total = parseInt(lista.attr('total') || '0', 10);

  const cards: CardInfo[] = [];

  lista.find('a.leilao-lote[data-id]').each((_, el) => {
    const $el = $(el);
    const id = $el.attr('data-id') || '';
    if (!id) return;

    const titulo = $el.find('h5.card-title').text().trim();

    // Imagem via background-image
    const styleStr = $el.find('[style*="background-image"]').attr('style') || '';
    const imgMatch = styleStr.match(/url\(([^")]+)/);
    const imagemUrl = imgMatch ? imgMatch[1] : '';

    // Preços: podem ter 1 (só lance) ou 2 (1º e 2º leilão)
    const precos: number[] = [];
    $el.find('*').each((_, node) => {
      const text = $(node).text().trim();
      const m = text.match(/^R\$\s*([\d.,]+)$/);
      if (m) {
        const v = extrairValor(m[1]);
        if (v > 0 && !precos.includes(v)) precos.push(v);
      }
    });

    cards.push({
      id,
      titulo,
      imagemUrl,
      preco1: precos[0] || 0,
      preco2: precos[1] || 0,
    });
  });

  return { cards, total };
}

// ── detalhe ───────────────────────────────────────────────────

interface DetalheInfo {
  endereco?: string;
  bairro?: string;
  cep?: string;
  areaTotal?: number;
  valorAvaliacao?: number;
  imagens: string[];
  dataLeilao?: Date;
}

function parsearDetalhe(html: string): DetalheInfo {
  const $ = cheerio.load(html);

  // Endereço completo: og:description → "Rua X, 123, Bairro, Cidade/UF"
  const ogDesc = $('meta[property="og:description"]').attr('content') || '';
  let endereco: string | undefined;
  let bairro: string | undefined;
  let cep: string | undefined;

  if (ogDesc) {
    const partes = ogDesc.split(',').map(p => p.trim());
    if (partes.length >= 2) {
      endereco = partes.slice(0, 2).join(', ');
      if (partes.length >= 3 && !partes[2].includes('/')) {
        bairro = partes[2];
      }
    }
  }

  // CEP
  const textoCompleto = $('body').text();
  const cepMatch = textoCompleto.match(/\b(\d{5}-?\d{3})\b/);
  if (cepMatch) cep = cepMatch[1].replace('-', '');

  // Área m²
  let areaTotal: number | undefined;
  const areaMatch = textoCompleto.match(/([0-9]+[.,][0-9]+|[0-9]+)\s*m[²2]/i);
  if (areaMatch) {
    const v = parseFloat(areaMatch[1].replace('.', '').replace(',', '.'));
    if (!isNaN(v) && v > 0) areaTotal = v;
  }

  // Valor de avaliação (nem sempre presente, Biasi foca no lance)
  let valorAvaliacao: number | undefined;
  const avalMatch = textoCompleto.match(/[Aa]valia[çc][aã]o[^R]*R\$\s*([\d.,]+)/);
  if (avalMatch) valorAvaliacao = extrairValor(avalMatch[1]);

  // Imagens
  const imagens: string[] = [];
  $('img[src*="cdn-biasi"]').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (src && !imagens.includes(src)) imagens.push(src);
  });
  // Também via background-image em slides
  $('[style*="background-image"]').each((_, el) => {
    const style = $(el).attr('style') || '';
    const m = style.match(/url\(([^")]+)/);
    if (m && m[1].includes('cdn-biasi') && !imagens.includes(m[1])) imagens.push(m[1]);
  });

  // Data do leilão
  let dataLeilao: Date | undefined;
  const datas = textoCompleto.match(/\d{2}\/\d{2}\/\d{4}/g);
  if (datas) {
    const [d, mo, a] = datas[0].split('/');
    const dt = new Date(`${a}-${mo}-${d}`);
    if (!isNaN(dt.getTime())) dataLeilao = dt;
  }

  return { endereco, bairro, cep, areaTotal, valorAvaliacao, imagens, dataLeilao };
}

// ── scraper principal ─────────────────────────────────────────

export async function scraperBiasi(): Promise<ScraperResult> {
  const imoveis: ImovelRaw[] = [];
  const erros: string[] = [];

  console.log('[Biasi] Iniciando scraper...');
  console.log('[Biasi] ── MG / UBERLANDIA ──────────────────');

  try {
    // Primeira página para saber o total
    const resp1 = await http.get(`${BASE_URL}/Sale/LotListSearch`, {
      params: {
        start: 0,
        limit: PAGE_SIZE,
        buscaImovel: true,
        estado: 'mg',
        cidade: 'uberlandia',
        bairro: 'todos-os-bairros',
        segmento: '',
        uf: '', cid: '', cat: '', sub: '', term: '', listaId: '', slug: '',
      },
    });

    const { cards: primeiraCards, total } = parsearLista(resp1.data as string);
    const totalPaginas = Math.max(1, Math.ceil(total / PAGE_SIZE));
    console.log(`[Biasi] ${total} lote(s) em ${totalPaginas} página(s)`);

    // Todas as páginas
    const todasCards: CardInfo[] = [...primeiraCards];
    for (let p = 1; p < totalPaginas; p++) {
      await new Promise(r => setTimeout(r, 1500));
      const resp = await http.get(`${BASE_URL}/Sale/LotListSearch`, {
        params: {
          start: p * PAGE_SIZE,
          limit: PAGE_SIZE,
          buscaImovel: true,
          estado: 'mg',
          cidade: 'uberlandia',
          bairro: 'todos-os-bairros',
          segmento: '',
          uf: '', cid: '', cat: '', sub: '', term: '', listaId: '', slug: '',
        },
      });
      const { cards } = parsearLista(resp.data as string);
      todasCards.push(...cards);
    }

    // Buscar detalhe de cada lote
    for (const card of todasCards) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const detResp = await http.get(`${BASE_URL}/sale/detail`, {
          params: { id: card.id },
          headers: { 'X-Requested-With': undefined, Accept: 'text/html,application/xhtml+xml' },
        });
        const det = parsearDetalhe(detResp.data as string);

        // Avaliação: usa o campo do detalhe; fallback: preco1 (lance do 1º leilão)
        const valorAvaliacao = det.valorAvaliacao || card.preco1 || 0;
        // Lance mínimo: preco2 (2º leilão) se existir, senão preco1
        const valorMinimo = (card.preco2 > 0 && card.preco2 < card.preco1)
          ? card.preco2
          : card.preco1;

        const tipo = normalizarTipo(card.titulo);
        const modalidade = normalizarModalidade(card.titulo, card.preco1, card.preco2);

        // Imagens: combinar card + detalhe
        const imagens: string[] = [];
        if (card.imagemUrl) imagens.push(card.imagemUrl);
        for (const img of det.imagens) {
          if (!imagens.includes(img)) imagens.push(img);
        }

        // Extrair bairro do título se não veio do endereço
        let bairro = det.bairro;
        if (!bairro) {
          const partesTitulo = card.titulo.split(/[-–—|em\s]+/i);
          for (const p of partesTitulo) {
            const trimmed = p.trim();
            if (trimmed.length > 3 && !trimmed.toLowerCase().includes('uberlândia') &&
                !trimmed.toLowerCase().includes('mg') && !trimmed.match(/^r\$/i)) {
              bairro = trimmed;
              break;
            }
          }
        }

        const im: ImovelRaw = {
          codigoFonte: `biasi-${card.id}`,
          urlFonte: `${BASE_URL}/sale/detail?id=${card.id}`,
          tipo,
          modalidade,
          estado: 'MG',
          cidade: 'Uberlândia',
          bairro,
          endereco: det.endereco,
          cep: det.cep,
          valorAvaliacao,
          valorMinimo,
          areaTotal: det.areaTotal,
          imagens,
          dataLeilao: det.dataLeilao,
        };

        imoveis.push(im);

        const desconto = valorAvaliacao > 0
          ? ((valorAvaliacao - valorMinimo) / valorAvaliacao * 100).toFixed(1)
          : '0.0';
        console.log(`  ✓ ${tipo} | ${bairro || 'Uberlândia'} | av: R$${valorAvaliacao.toLocaleString('pt-BR')} | mín: R$${valorMinimo.toLocaleString('pt-BR')} | ${desconto}% desc`);
      } catch (err: any) {
        const msg = `[Biasi] Erro no detalhe id=${card.id}: ${err.message}`;
        console.error(msg);
        erros.push(msg);
      }
    }
  } catch (err: any) {
    const msg = `[Biasi] Erro geral: ${err.message}`;
    console.error(msg);
    erros.push(msg);
  }

  console.log(`\n[Biasi] Total: ${imoveis.length} imóveis, ${erros.length} erros`);
  return { imoveis, erros };
}
