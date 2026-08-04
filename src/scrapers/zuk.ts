/**
 * Scraper — Portal ZUK (portalzuk.com.br)
 *
 * Estratégia:
 * 1. GET da página de listagem para Uberlândia/MG
 * 2. Extrai o array `properties` embutido em <script> para lat/lng,
 *    desconto%, valor, área, quartos, vagas
 * 3. Parseia os cards HTML para tipo, endereço, imagem, data
 * 4. Pagina via GET adicionando /pagina/N à URL
 * 5. Não precisa de Playwright — conteúdo é server-side rendered
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { ImovelRaw, ScraperResult } from './types';

const BASE_URL = 'https://www.portalzuk.com.br';
const IMG_BASE = 'https://imagens.portalzuk.com.br';

// URL de listagem por cidade
function urlListagem(pagina = 1): string {
  const base = `${BASE_URL}/leilao-de-imoveis/c/todos-imoveis/mg/regiao/uberlandia`;
  return pagina === 1 ? base : `${base}/pagina/${pagina}`;
}

const http = axios.create({
  timeout: 25000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9',
    'Referer': BASE_URL,
  },
});

// ── tipos auxiliares ──────────────────────────────────────────
interface ZukProp {
  il: number;       // id imóvel
  ilo: number;      // id lote
  la?: string;      // latitude
  lo?: string;      // longitude
  lv?: number;      // lance/valor mínimo (em centavos ou reais?)
  max_area?: number;
  i_abaixo?: number; // desconto % abaixo da avaliação
  i_res?: number;   // residencial flag
  i_com?: number;   // comercial flag
  i_rur?: number;   // rural flag
  i_ter?: number;   // terreno flag
  if_dorm?: number; // dormitórios
  if_vag?: number;  // vagas
  if_ban?: number;  // banheiros
}

// ── helpers ───────────────────────────────────────────────────

function normalizarTipo(texto: string, prop?: ZukProp): ImovelRaw['tipo'] {
  const t = texto.toLowerCase();
  if (prop) {
    if (prop.i_ter) return 'terreno';
    if (prop.i_rur) return 'rural';
    if (prop.i_com) return 'comercial';
  }
  if (t.includes('apart') || t.includes('apto') || t.includes('kitnet') || t.includes('flat')) return 'apartamento';
  if (t.includes('casa') || t.includes('sobrado') || t.includes('chácara') || t.includes('chacara')) return 'casa';
  if (t.includes('terreno') || t.includes('lote') || t.includes('gleba')) return 'terreno';
  if (t.includes('comercial') || t.includes('sala') || t.includes('loja') || t.includes('galpão')) return 'comercial';
  if (t.includes('rural') || t.includes('sítio') || t.includes('sitio') || t.includes('fazenda')) return 'rural';
  return 'outro';
}

function extrairValor(texto: string): number {
  const limpo = texto.replace(/\./g, '').replace(',', '.');
  const match = limpo.match(/[\d]+\.?\d*/);
  return match ? parseFloat(match[0]) : 0;
}

function extrairArea(texto: string): number | undefined {
  const match = texto.match(/([\d.,]+)\s*m[²2]/i);
  if (!match) return undefined;
  return parseFloat(match[1].replace('.', '').replace(',', '.')) || undefined;
}

function miniParaDetalhe(url: string): string {
  return url.replace('/mini/', '/detalhe/');
}

// Extrai o array `properties` do JS embutido na página
function extrairPropertiesJSON(html: string): ZukProp[] {
  // Tenta: properties = [{...}]  ou  var properties=[{...}]
  const match = html.match(/properties\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) return [];
  try {
    return JSON.parse(match[1]);
  } catch {
    return [];
  }
}

// Lê total de páginas do HTML
function lerTotalPaginas($: ReturnType<typeof cheerio.load>): number {
  // Paginação pode estar em li.page-item ou .pagination
  const ultima = $('ul.pagination li:not(.next):not(.prev)').last().text().trim();
  const n = parseInt(ultima);
  return isNaN(n) || n < 1 ? 1 : n;
}

interface CardInfo {
  codigoFonte: string;  // il-ilo
  urlFonte: string;
  tipoTexto: string;
  bairro: string;
  endereco: string;
  areaTexto: string;
  lanceTexto: string;
  dataTexto: string;
  imagemUrl: string;
  modalidade: ImovelRaw['modalidade'];
}

function parsearCards($: ReturnType<typeof cheerio.load>): CardInfo[] {
  const cards: CardInfo[] = [];

  $('a[href*="/imovel/mg/uberlandia/"]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || '';

    // Extrai il-ilo do final da URL: /36803-229573
    const idMatch = href.match(/\/(\d+-\d+)\s*$/);
    if (!idMatch) return;
    const codigoFonte = `zuk-${idMatch[1]}`;
    const urlFonte = href.startsWith('http') ? href : `${BASE_URL}${href}`;

    // Imagem
    const imgSrc = $el.find('img').first().attr('src') || '';
    const imagemUrl = imgSrc ? miniParaDetalhe(imgSrc) : '';

    // Tipo (primeiro div de texto)
    const divs = $el.find('div').map((_, d) => $(d).text().trim()).get().filter(Boolean);
    const tipoTexto = divs[0] || '';

    // Localização: "Uberlândia / MG - BAIRRO | Endereço"
    const localizacao = divs[1] || '';
    const bairroMatch = localizacao.match(/-\s*(.+?)\s*\|/);
    const enderecoMatch = localizacao.match(/\|\s*(.+)$/);
    const bairro = bairroMatch ? bairroMatch[1].trim() : '';
    const endereco = enderecoMatch ? enderecoMatch[1].trim() : '';

    // Área
    const areaTexto = divs.find(d => d.includes('m²')) || '';

    // Valor e data: "Lance inicial R$ 382.989,60 | 03/08/2026 às 13:00"
    const lanceDiv = divs.find(d => d.includes('R$')) || '';
    const lanceTexto = lanceDiv;
    const dataMatch = lanceDiv.match(/(\d{2}\/\d{2}\/\d{2,4})/);
    const dataTexto = dataMatch ? dataMatch[1] : '';

    // Modalidade pela classe do card pai
    const parentClass = $el.parent().attr('class') || $el.attr('class') || '';
    let modalidade: ImovelRaw['modalidade'] = 'licitacao';
    if (parentClass.includes('encerrado')) modalidade = 'venda_direta';
    else if (parentClass.includes('condicional')) modalidade = 'licitacao';
    else if (parentClass.includes('proposta')) modalidade = 'licitacao';

    cards.push({
      codigoFonte,
      urlFonte,
      tipoTexto,
      bairro,
      endereco,
      areaTexto,
      lanceTexto,
      dataTexto,
      imagemUrl,
      modalidade,
    });
  });

  return cards;
}

// ── scraper principal ────────────────────────────────────────

async function scraperPagina(pagina: number): Promise<{
  html: string;
  props: ZukProp[];
  cards: CardInfo[];
  totalPaginas: number;
}> {
  const url = urlListagem(pagina);
  const resp = await http.get(url);
  const html = resp.data as string;
  const $ = cheerio.load(html);

  return {
    html,
    props: extrairPropertiesJSON(html),
    cards: parsearCards($),
    totalPaginas: pagina === 1 ? lerTotalPaginas($) : 1,
  };
}

export async function scraperZuk(): Promise<ScraperResult> {
  const imoveis: ImovelRaw[] = [];
  const erros: string[] = [];

  console.log('[ZUK] Iniciando scraper...');
  console.log('[ZUK] ── MG / UBERLANDIA ──────────────────');

  try {
    // Página 1 para saber total
    const primeira = await scraperPagina(1);
    const { totalPaginas } = primeira;
    console.log(`[ZUK] ${totalPaginas} página(s) encontrada(s)`);

    // Processa todas as páginas
    for (let p = 1; p <= totalPaginas; p++) {
      let pageData = primeira;
      if (p > 1) {
        try {
          pageData = await scraperPagina(p);
          await new Promise(r => setTimeout(r, 800));
        } catch (err: any) {
          erros.push(`[ZUK] Erro na página ${p}: ${err.message}`);
          continue;
        }
      }

      // Cria mapa id → ZukProp para cruzamento
      const propMap = new Map<string, ZukProp>();
      for (const prop of pageData.props) {
        propMap.set(`zuk-${prop.il}-${prop.ilo}`, prop);
      }

      console.log(`  Página ${p}/${totalPaginas}: ${pageData.cards.length} itens`);

      for (const card of pageData.cards) {
        // Busca dados do JSON por il-ilo
        const prop = propMap.get(card.codigoFonte);

        // Valor mínimo: do JSON (lv) ou do texto do card
        const lanceValor = prop?.lv
          ? (prop.lv > 100000 ? prop.lv : prop.lv * 100)  // às vezes em centavos
          : extrairValor(card.lanceTexto);

        if (lanceValor === 0) continue;

        // Valor de avaliação: calculado a partir do desconto
        const desconto = prop?.i_abaixo ?? 0;
        const valorAvaliacao = desconto > 0 && desconto < 100
          ? lanceValor / (1 - desconto / 100)
          : lanceValor; // sem desconto = igual ao lance

        const valorMinimo = lanceValor;

        // Data do leilão
        let dataLeilao: Date | undefined;
        if (card.dataTexto) {
          const [d, m, a] = card.dataTexto.split('/');
          const ano = a.length === 2 ? `20${a}` : a;
          const dt = new Date(`${ano}-${m}-${d}`);
          if (!isNaN(dt.getTime())) dataLeilao = dt;
        }

        // Área — prefere JSON, cai no texto do card
        const areaTotal = prop?.max_area || extrairArea(card.areaTexto);

        // Lat/lng direto do JSON — sem precisar de Nominatim!
        const latitude = prop?.la ? parseFloat(prop.la) : undefined;
        const longitude = prop?.lo ? parseFloat(prop.lo) : undefined;

        const im: ImovelRaw = {
          codigoFonte: card.codigoFonte,
          urlFonte: card.urlFonte,
          tipo: normalizarTipo(card.tipoTexto, prop),
          modalidade: card.modalidade,
          estado: 'MG',
          cidade: 'Uberlândia',
          bairro: card.bairro || undefined,
          endereco: card.endereco || undefined,
          valorAvaliacao,
          valorMinimo,
          areaTotal,
          quartos: prop?.if_dorm || undefined,
          vagas: prop?.if_vag || undefined,
          imagens: card.imagemUrl ? [card.imagemUrl] : [],
          dataLeilao,
          latitude,
          longitude,
        };

        imoveis.push(im);
        console.log(`  ✓ ${im.tipo} | ${im.bairro || 'Uberlândia'} | av: R$${valorAvaliacao.toLocaleString('pt-BR')} | mín: R$${valorMinimo.toLocaleString('pt-BR')} | ${desconto.toFixed(1)}% desc`);
      }
    }
  } catch (err: any) {
    const msg = `[ZUK] Erro geral: ${err.message}`;
    console.error(msg);
    erros.push(msg);
  }

  console.log(`\n[ZUK] Total: ${imoveis.length} imóveis, ${erros.length} erros`);
  return { imoveis, erros };
}
