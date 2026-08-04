/**
 * Scraper — Spy Leilões (spyleiloes.com.br)
 *
 * Estratégia:
 * 1. GET em /imoveis-leilao/mg/uberlandia?page=N — página SSR Next.js com dados reais no HTML
 * 2. Extrai analytics JSON embutido em <script data-spy-event="view_item_list">
 *    → contém: item_id, item_category, price (1º leilão), desconto%, avaliacao
 * 3. Extrai HTML dos cards (<a href="/leilao/{id}/...">) na mesma ordem do JSON
 *    → contém: imagem, endereço completo, datas do leilão, preço 2º leilão
 * 4. Pagina via ?page=N até não ter mais resultados (total em buscaResultados)
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { ImovelRaw, ScraperResult } from './types';

const BASE_URL = 'https://www.spyleiloes.com.br';
const PAGE_SIZE = 20;

function listingUrl(page: number): string {
  return `${BASE_URL}/imoveis-leilao/mg/uberlandia${page > 1 ? `?page=${page}` : ''}`;
}

const http = axios.create({
  timeout: 30000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9',
    'Referer': BASE_URL,
  },
});

// ── tipos ─────────────────────────────────────────────────────

interface SpyAnalyticsItem {
  item_id: string;
  item_name: string;
  item_category: string;  // Apartamento, Casa, Comercial, Terreno, Rural
  price: number;          // 1º leilão lance
  desconto?: string;      // % ou "0"
  avaliacao?: string;     // valor de avaliação
}

// ── normalizadores ────────────────────────────────────────────

function normalizarTipo(categoria: string): ImovelRaw['tipo'] {
  const c = categoria.toLowerCase();
  if (c.includes('apart') || c.includes('kitnet') || c.includes('flat')) return 'apartamento';
  if (c.includes('casa') || c.includes('sobrado') || c.includes('chácara') || c.includes('chacara')) return 'casa';
  if (c.includes('terreno') || c.includes('lote') || c.includes('gleba')) return 'terreno';
  if (c.includes('comercial') || c.includes('sala') || c.includes('loja') || c.includes('galpão')) return 'comercial';
  if (c.includes('rural') || c.includes('sítio') || c.includes('sitio') || c.includes('fazenda')) return 'rural';
  return 'outro';
}

function extrairValor(texto: string): number {
  const limpo = texto.replace(/\./g, '').replace(',', '.');
  const m = limpo.match(/[\d]+\.?\d*/);
  return m ? parseFloat(m[0]) : 0;
}

function extrairArea(texto: string): number | undefined {
  const m = texto.match(/([\d.,]+)\s*m[²2]/i);
  if (!m) return undefined;
  const v = parseFloat(m[1].replace('.', '').replace(',', '.'));
  return isNaN(v) ? undefined : v;
}

function parsearData(texto: string): Date | undefined {
  const m = texto.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return undefined;
  const d = new Date(`${m[3]}-${m[2]}-${m[1]}`);
  return isNaN(d.getTime()) ? undefined : d;
}

function parsearBairroDoEndereco(endereco: string): string | undefined {
  // Formato típico: "Rua X, 123 - Apto 1, BAIRRO, Cidade - Estado, Cep XXXXX-XXX"
  // Tenta extrair o bairro (antes da cidade)
  const partes = endereco.split(',').map(p => p.trim());
  // Bairro é geralmente a 3ª ou 4ª parte
  for (let i = 1; i < partes.length; i++) {
    const p = partes[i];
    if (!p.match(/^\d/) && !p.includes('Cep') && !p.includes('CEP') &&
        !p.includes('Uberlândia') && !p.includes('Minas') && !p.includes('MG')) {
      // Limpar número de apto/complemento
      const limpo = p.replace(/^(Apto?\.?|Torre|Bloco|Sala|Loja)\s+\S+/i, '').trim();
      if (limpo.length > 3 && !limpo.match(/^\d/)) return limpo;
    }
  }
  return undefined;
}

// ── extração do JSON de analytics ────────────────────────────

function extrairAnalyticsItems(html: string): { items: SpyAnalyticsItem[], total: number } {
  // Script: <script data-spy-event="view_item_list">window.dataLayer=...push({..., "items":[...]})
  const match = html.match(/"items":\s*(\[[\s\S]*?\])\s*\}/);
  if (!match) return { items: [], total: 0 };

  let items: SpyAnalyticsItem[] = [];
  try {
    items = JSON.parse(match[1]);
  } catch {
    return { items: [], total: 0 };
  }

  // Total de resultados da busca
  const totalMatch = html.match(/"buscaResultados":\s*(\d+)/);
  const total = totalMatch ? parseInt(totalMatch[1]) : 0;

  return { items, total };
}

// ── extração de dados do card HTML ────────────────────────────

interface CardData {
  id: string;
  urlFonte: string;
  imagemUrl: string;
  endereco: string;
  bairro?: string;
  dataLeilao1?: Date;
  dataLeilao2?: Date;
  preco2?: number;      // preço do 2º leilão (normalmente mais barato)
  modalidade: ImovelRaw['modalidade'];
}

function extrairCards($: ReturnType<typeof cheerio.load>): CardData[] {
  const cards: CardData[] = [];

  $('a[href*="/leilao/"]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || '';

    // ID da URL: /leilao/{id}/{slug}
    const idMatch = href.match(/\/leilao\/(\d+)\//);
    if (!idMatch) return;
    const id = idMatch[1];

    const urlFonte = href.startsWith('http') ? href : `${BASE_URL}${href}`;

    // Imagem (primeira img não-SVG dentro do card)
    const img = $el.find('img').filter((_, i) => {
      const src = $(i).attr('src') || '';
      return src.startsWith('http') && !src.includes('.svg');
    }).first();
    const imagemUrl = img.attr('src') || '';

    // Endereço: procura a <p> com texto de rua ou a div com localização
    const textoCompleto = $el.text();
    const enderecoMatch = textoCompleto.match(/([A-Za-zÀ-ÿ][^,\n]+,\s*\d+[^,\n]*(?:,\s*(?:Apto?\.?|Torre|Bloco|Sala)[^\n,]+)?)/i);
    const endereco = enderecoMatch ? enderecoMatch[0].trim() : '';
    const bairro = endereco ? parsearBairroDoEndereco(endereco) : undefined;

    // Datas: procura padrões dd/mm/yyyy no texto do card
    const datasMatch = textoCompleto.match(/\d{2}\/\d{2}\/\d{4}/g) || [];
    const dataLeilao1 = datasMatch[0] ? parsearData(datasMatch[0]) : undefined;
    const dataLeilao2 = datasMatch[1] ? parsearData(datasMatch[1]) : undefined;

    // Preços das datas (o segundo geralmente é mais barato = 2º leilão)
    const precosMatch = textoCompleto.match(/R\$\s*[\d.,]+/g) || [];
    let preco2: number | undefined;
    if (precosMatch.length >= 2) {
      const v1 = extrairValor(precosMatch[0]!);
      const v2 = extrairValor(precosMatch[precosMatch.length - 1]!);
      if (v2 > 0 && v2 < v1) preco2 = v2;
    }

    // Modalidade
    const textoLower = textoCompleto.toLowerCase();
    let modalidade: ImovelRaw['modalidade'] = 'licitacao';
    if (textoLower.includes('venda direta') || textoLower.includes('extrajudicial')) {
      modalidade = 'venda_direta';
    } else if (textoLower.includes('2º leilão') || textoLower.includes('2o leilão')) {
      modalidade = 'segundo_leilao';
    } else if (textoLower.includes('1º leilão') || textoLower.includes('1o leilão') || textoLower.includes('judicial')) {
      modalidade = 'primeiro_leilao';
    }

    cards.push({ id, urlFonte, imagemUrl, endereco, bairro, dataLeilao1, dataLeilao2, preco2, modalidade });
  });

  return cards;
}

// ── scraper principal ────────────────────────────────────────

async function scraperPagina(page: number): Promise<{
  items: SpyAnalyticsItem[];
  cards: CardData[];
  total: number;
}> {
  const resp = await http.get(listingUrl(page));
  const html = resp.data as string;
  const $ = cheerio.load(html);

  const { items, total } = extrairAnalyticsItems(html);
  const cards = extrairCards($);

  return { items, cards, total };
}

export async function scraperSpy(): Promise<ScraperResult> {
  const imoveis: ImovelRaw[] = [];
  const erros: string[] = [];

  console.log('[SPY] Iniciando scraper...');
  console.log('[SPY] ── MG / UBERLANDIA ──────────────────');

  try {
    // Página 1 para descobrir total
    const primeira = await scraperPagina(1);
    const totalItems = primeira.total;
    const totalPaginas = totalItems > 0 ? Math.ceil(totalItems / PAGE_SIZE) : 1;
    console.log(`[SPY] ${totalItems} imóveis em ${totalPaginas} página(s)`);

    // Processar todas as páginas
    for (let p = 1; p <= totalPaginas; p++) {
      let { items, cards } = p === 1 ? primeira : await scraperPagina(p);

      if (p > 1) await new Promise(r => setTimeout(r, 800));

      console.log(`  Página ${p}/${totalPaginas}: ${items.length} items (${cards.length} cards)`);

      // Cross-referência por posição (items e cards estão na mesma ordem)
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const card = cards[i]; // pode ser undefined se contagens divergirem

        // Localizar card correto pelo id na URL como fallback
        const cardById = cards.find(c => c.id === item.item_id);
        const cardFinal = cardById || card;

        const valorMinimo1 = item.price;
        const valorAvaliacao = item.avaliacao ? parseFloat(item.avaliacao) : valorMinimo1;
        const valorMinimo = (cardFinal?.preco2 && cardFinal.preco2 < valorMinimo1 && cardFinal.preco2 > 0)
          ? cardFinal.preco2
          : valorMinimo1;

        if (valorMinimo === 0) continue;

        const urlFonte = cardFinal?.urlFonte || `${BASE_URL}/leilao/${item.item_id}`;
        const tipo = normalizarTipo(item.item_category);

        const im: ImovelRaw = {
          codigoFonte: `spy-${item.item_id}`,
          urlFonte,
          tipo,
          modalidade: cardFinal?.modalidade || 'licitacao',
          estado: 'MG',
          cidade: 'Uberlândia',
          bairro: cardFinal?.bairro,
          endereco: cardFinal?.endereco || undefined,
          valorAvaliacao: valorAvaliacao > 0 ? valorAvaliacao : valorMinimo,
          valorMinimo,
          imagens: cardFinal?.imagemUrl ? [cardFinal.imagemUrl] : [],
          dataLeilao: cardFinal?.dataLeilao1 || cardFinal?.dataLeilao2,
        };

        imoveis.push(im);

        const desconto = im.valorAvaliacao > 0
          ? ((im.valorAvaliacao - im.valorMinimo) / im.valorAvaliacao * 100).toFixed(1)
          : '0.0';
        console.log(`  ✓ ${tipo} | ${im.bairro || 'Uberlândia'} | av: R$${im.valorAvaliacao.toLocaleString('pt-BR')} | mín: R$${im.valorMinimo.toLocaleString('pt-BR')} | ${desconto}% desc`);
      }
    }
  } catch (err: any) {
    const msg = `[SPY] Erro geral: ${err.message}`;
    console.error(msg);
    erros.push(msg);
  }

  console.log(`\n[SPY] Total: ${imoveis.length} imóveis, ${erros.length} erros`);
  return { imoveis, erros };
}
