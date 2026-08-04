/**
 * Scraper — Leilões Judiciais (leiloesjudiciais.com.br)
 *
 * Estratégia:
 * 1. GET em /imoveis?uf=MG&municipio=Uberlandia&pagina=N — Nuxt SSR com dados reais no HTML
 * 2. Parseia os cards <div class="base-card"> com Cheerio
 *    → título, cidade/estado, imagem, avaliação, lance mínimo, data
 * 3. Filtra apenas imóveis de Uberlândia/MG (podem aparecer outros destacados)
 * 4. Pagina: paginação está na URL como &pagina=N (total de páginas no HTML)
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { ImovelRaw, ScraperResult } from './types';

const BASE_URL = 'https://www.leiloesjudiciais.com.br';

function listingUrl(pagina: number): string {
  const base = `${BASE_URL}/imoveis?uf=MG&municipio=Uberlandia`;
  return pagina <= 1 ? base : `${base}&pagina=${pagina}`;
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

// ── normalizadores ────────────────────────────────────────────

function normalizarTipo(titulo: string): ImovelRaw['tipo'] {
  const t = titulo.toLowerCase();
  if (t.includes('apart') || t.includes('apto') || t.includes('kitnet') || t.includes('flat')) return 'apartamento';
  if (t.includes('casa') || t.includes('sobrado') || t.includes('chácara') || t.includes('chacara') || t.includes('residencia')) return 'casa';
  if (t.includes('terreno') || t.includes('lote') || t.includes('gleba')) return 'terreno';
  if (t.includes('comercial') || t.includes('sala') || t.includes('loja') || t.includes('galpão') || t.includes('galpao') || t.includes('ponto') || t.includes('prédio') || t.includes('predio')) return 'comercial';
  if (t.includes('rural') || t.includes('sítio') || t.includes('sitio') || t.includes('fazenda') || t.includes('granja') || t.includes('cháca')) return 'rural';
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
  // Formatos: dd/mm/yyyy, dd/mm/yy
  const m = texto.match(/(\d{2})\/(\d{2})\/(\d{2,4})/);
  if (!m) return undefined;
  const ano = m[3].length === 2 ? `20${m[3]}` : m[3];
  const d = new Date(`${ano}-${m[2]}-${m[1]}`);
  return isNaN(d.getTime()) ? undefined : d;
}

function normalizarModalidade(texto: string): ImovelRaw['modalidade'] {
  const t = texto.toLowerCase();
  if (t.includes('2ª') || t.includes('segundo')) return 'segundo_leilao';
  if (t.includes('1ª') || t.includes('primeiro')) return 'primeiro_leilao';
  if (t.includes('venda direta') || t.includes('extrajudicial')) return 'venda_direta';
  return 'licitacao';
}

// ── leitor de total de páginas ────────────────────────────────

function lerTotalPaginas($: ReturnType<typeof cheerio.load>): number {
  // Paginação: aria-label="Ir para a página 27 de 27" ou "página 1 de 27"
  let max = 1;
  $('a[aria-label]').each((_, el) => {
    const label = $(el).attr('aria-label') || '';
    const m = label.match(/p[áa]gina\s+(\d+)\s+de\s+(\d+)/i);
    if (m) {
      const total = parseInt(m[2]);
      if (!isNaN(total) && total > max) max = total;
    }
  });
  return max;
}

// ── parser de cards ──────────────────────────────────────────

interface CardLJ {
  leilaoId: string;
  loteId: string;
  titulo: string;
  cidadeEstado: string;
  imagemUrl: string;
  valorAvaliacao: number;
  valorMinimo: number;
  dataLeilao?: Date;
  modalidade: ImovelRaw['modalidade'];
  status: string;
}

function parsearCards($: ReturnType<typeof cheerio.load>): CardLJ[] {
  const cards: CardLJ[] = [];

  $('div.base-card').each((_, el) => {
    const $el = $(el);

    // URL: /lote/{leilao_id}/{lote_id}
    const href = $el.find('a.card-lote-leilao').attr('href') || '';
    const idMatch = href.match(/\/lote\/(\d+)\/(\d+)/);
    if (!idMatch) return;
    const [, leilaoId, loteId] = idMatch;

    // Título (do alt da imagem ou do card-header)
    const titulo = $el.find('div.card-header span').text().trim()
      || $el.find('img.imagem__lote').attr('alt')
      || '';
    if (!titulo) return;

    // Cidade/Estado
    const cidadeEstado = $el.find('div.cidade-estado span').last().text().trim();

    // Imagem
    const imagemUrl = $el.find('img.imagem__lote').attr('src') || '';

    // Valores: dentro de .label-valor
    let valorAvaliacao = 0;
    let valorMinimo = 0;

    $el.find('div.label-valor').each((_, lv) => {
      const $lv = $(lv);
      const label = $lv.find('span').first().text().trim().toLowerCase();
      const valorTexto = $lv.find('span').last().text().trim()
        || $lv.find('strong').text().trim();

      if (label.includes('avaliação') || label.includes('avaliacao')) {
        valorAvaliacao = extrairValor(valorTexto);
      } else if (label.includes('lance mínimo') || label.includes('lance minimo') || label.includes('lance inicial')) {
        valorMinimo = extrairValor(valorTexto);
      }
    });

    if (valorMinimo === 0 && valorAvaliacao === 0) return;
    if (valorMinimo === 0) valorMinimo = valorAvaliacao;
    if (valorAvaliacao === 0) valorAvaliacao = valorMinimo;

    // Status (aberto-para-lances, encerrado, etc.)
    const statusEl = $el.find('div.status span').first();
    const status = statusEl.text().trim();

    // Modalidade pelo status
    const modalidade = normalizarModalidade(titulo + ' ' + status);

    // Data do leilão — procurar no texto do card
    let dataLeilao: Date | undefined;
    const textoCard = $el.text();
    const datasMatch = textoCard.match(/\d{2}\/\d{2}\/\d{4}/g);
    if (datasMatch) {
      dataLeilao = parsearData(datasMatch[0]);
    }

    cards.push({ leilaoId, loteId, titulo, cidadeEstado, imagemUrl, valorAvaliacao, valorMinimo, dataLeilao, modalidade, status });
  });

  return cards;
}

// ── scraper principal ────────────────────────────────────────

async function scraperPagina(pagina: number): Promise<{
  cards: CardLJ[];
  totalPaginas: number;
}> {
  const resp = await http.get(listingUrl(pagina));
  const html = resp.data as string;
  const $ = cheerio.load(html);

  const cards = parsearCards($);
  const totalPaginas = pagina === 1 ? lerTotalPaginas($) : 1;

  return { cards, totalPaginas };
}

export async function scraperLeiloesJudiciais(): Promise<ScraperResult> {
  const imoveis: ImovelRaw[] = [];
  const erros: string[] = [];
  const vistos = new Set<string>();

  console.log('[LJ] Iniciando scraper...');
  console.log('[LJ] ── MG / UBERLANDIA ──────────────────');

  try {
    const primeira = await scraperPagina(1);
    const { totalPaginas } = primeira;
    console.log(`[LJ] ${totalPaginas} página(s)`);

    for (let p = 1; p <= totalPaginas; p++) {
      let { cards } = p === 1 ? primeira : await scraperPagina(p);
      if (p > 1) await new Promise(r => setTimeout(r, 1000));

      let novosNestaPagina = 0;

      for (const card of cards) {
        // Filtrar apenas Uberlândia/MG
        const loc = card.cidadeEstado.toUpperCase();
        if (!loc.includes('UBERLÂNDIA') && !loc.includes('UBERLANDIA') && !loc.includes('UBERL')) {
          continue;
        }

        // Imóveis encerrados ou sem lance não são úteis
        if (card.status.toLowerCase().includes('encerrado')) continue;

        const codigo = `lj-${card.loteId}`;
        if (vistos.has(codigo)) continue;
        vistos.add(codigo);

        const urlFonte = `${BASE_URL}/lote/${card.leilaoId}/${card.loteId}`;
        const tipo = normalizarTipo(card.titulo);
        const area = extrairArea(card.titulo);

        // Extrai bairro do título quando possível
        // Formato comum: "APARTAMENTO - BAIRRO - UBERLÂNDIA/MG" ou "Apartamento no Bairro X"
        let bairro: string | undefined;
        const tituloPartes = card.titulo.split(/[-–—|]/);
        if (tituloPartes.length >= 3) {
          const candidato = tituloPartes[1].trim();
          if (candidato.length > 3 && !candidato.toUpperCase().includes('UBERLÂNDIA') &&
              !candidato.match(/^\d/) && !candidato.toLowerCase().includes('mg')) {
            bairro = candidato.replace(/\s+/g, ' ');
          }
        }

        const im: ImovelRaw = {
          codigoFonte: codigo,
          urlFonte,
          tipo,
          modalidade: card.modalidade,
          estado: 'MG',
          cidade: 'Uberlândia',
          bairro,
          valorAvaliacao: card.valorAvaliacao,
          valorMinimo: card.valorMinimo,
          areaTotal: area,
          imagens: card.imagemUrl ? [card.imagemUrl] : [],
          dataLeilao: card.dataLeilao,
        };

        imoveis.push(im);
        novosNestaPagina++;

        const desconto = im.valorAvaliacao > 0
          ? ((im.valorAvaliacao - im.valorMinimo) / im.valorAvaliacao * 100).toFixed(1)
          : '0.0';
        console.log(`  ✓ ${tipo} | ${bairro || 'Uberlândia'} | av: R$${im.valorAvaliacao.toLocaleString('pt-BR')} | mín: R$${im.valorMinimo.toLocaleString('pt-BR')} | ${desconto}% desc`);
      }

      console.log(`  Página ${p}/${totalPaginas}: ${novosNestaPagina} de Uberlândia (${cards.length} total)`);
    }
  } catch (err: any) {
    const msg = `[LJ] Erro geral: ${err.message}`;
    console.error(msg);
    erros.push(msg);
  }

  console.log(`\n[LJ] Total: ${imoveis.length} imóveis, ${erros.length} erros`);
  return { imoveis, erros };
}
