/**
 * Scraper — SOLD / Superbid (www.superbid.net)
 *
 * Estratégia:
 * 1. Abre o Superbid com Playwright (SPA React — não renderiza via axios)
 * 2. Intercepta as chamadas JSON ao offer-panel.superbid.net para obter dados estruturados
 * 3. Quando não há dados via API, faz fallback para parsing do DOM
 * 4. Filtra por MG / Uberlândia via query string
 * 5. Pagina incrementando pageNumber na URL
 */

import { chromium } from 'playwright';
import { ImovelRaw, ScraperResult } from './types';

const BASE_URL = 'https://www.superbid.net';
const PAGE_SIZE = 30;

function listingUrl(pageNumber: number): string {
  return (
    `${BASE_URL}/categorias/imoveis` +
    `?pageNumber=${pageNumber}` +
    `&pageSize=${PAGE_SIZE}` +
    `&orderBy=score:desc` +
    `&filterBy=state:MG,city:Uberlandia`
  );
}

// ── normalizadores ────────────────────────────────────────────

function normalizarTipo(texto: string): ImovelRaw['tipo'] {
  const t = texto.toLowerCase();
  if (t.includes('apart') || t.includes('apto') || t.includes('kitnet') || t.includes('flat')) return 'apartamento';
  if (t.includes('casa') || t.includes('sobrado') || t.includes('chácara') || t.includes('chacara')) return 'casa';
  if (t.includes('terreno') || t.includes('lote') || t.includes('gleba')) return 'terreno';
  if (t.includes('comercial') || t.includes('sala') || t.includes('loja') || t.includes('galpão') || t.includes('galpao')) return 'comercial';
  if (t.includes('rural') || t.includes('sítio') || t.includes('sitio') || t.includes('fazenda')) return 'rural';
  return 'outro';
}

function normalizarOcupado(texto: string): ImovelRaw['ocupado'] {
  const t = texto.toLowerCase();
  if (t.includes('desocup')) return 'nao';
  if (t.includes('ocup')) return 'sim';
  return 'desconhecido';
}

function normalizarModalidade(texto: string): ImovelRaw['modalidade'] {
  const t = texto.toLowerCase();
  if (t.includes('2ª') || t.includes('segunda') || t.includes('segundo leilão')) return 'segundo_leilao';
  if (t.includes('1ª') || t.includes('primeira') || t.includes('primeiro leilão')) return 'primeiro_leilao';
  if (t.includes('venda direta') || t.includes('mercado balcão') || t.includes('balcao')) return 'venda_direta';
  return 'licitacao';
}

function extrairValor(texto: string): number {
  const limpo = texto.replace(/\./g, '').replace(',', '.');
  const match = limpo.match(/[\d]+\.?\d*/);
  return match ? parseFloat(match[0]) : 0;
}

function extrairArea(texto: string): number | undefined {
  const match = texto.match(/([\d.,]+)\s*m[²2²]/i);
  if (!match) return undefined;
  const val = parseFloat(match[1].replace('.', '').replace(',', '.'));
  return isNaN(val) ? undefined : val;
}

// ── parser de título do card ──────────────────────────────────
// Formato esperado: "Tipo, StatusOcupacao, Xm2, CIDADE / UF"
// Exemplo: "Loja, Desocupado, 57.0 m2, BELO HORIZONTE / MG"

interface TituloInfo {
  tipo: ImovelRaw['tipo'];
  ocupado: ImovelRaw['ocupado'];
  area?: number;
  cidade: string;
  estado: string;
}

function parsearTitulo(titulo: string): TituloInfo {
  const partes = titulo.split(',').map(p => p.trim());

  const tipo = normalizarTipo(partes[0] || '');
  const ocupado = normalizarOcupado(partes[1] || '');
  const areaTexto = partes.find(p => p.match(/m[²2²]/i)) || '';
  const area = extrairArea(areaTexto);

  // Local: "BELO HORIZONTE / MG" ou apenas "UBERLÂNDIA / MG"
  const ultimaParte = partes[partes.length - 1] || '';
  const localMatch = ultimaParte.match(/(.+?)\s*\/\s*([A-Z]{2})\s*$/);
  const cidade = localMatch ? localMatch[1].trim() : 'Uberlândia';
  const estado = localMatch ? localMatch[2].trim() : 'MG';

  return { tipo, ocupado, area, cidade, estado };
}

// ── extrator de imóveis do JSON da API ────────────────────────

function parsearRespostaAPI(json: any): ImovelRaw[] {
  const results: ImovelRaw[] = [];

  // A resposta pode vir em campos diferentes dependendo da versão da API
  const itens: any[] =
    json?.content ||
    json?.data?.lots ||
    json?.lots ||
    json?.items ||
    json?.results ||
    (Array.isArray(json) ? json : []);

  if (!itens.length) return results;

  for (const item of itens) {
    try {
      // Campos possíveis na API do Superbid
      const id = item.id ?? item.lotId ?? item.offerId ?? item.codigo;
      if (!id) continue;

      const titulo = item.title ?? item.name ?? item.description ?? '';
      const preco = item.price ?? item.minimumBid ?? item.valor ?? 0;
      const avaliacaoApi = item.appraisal ?? item.valorAvaliacao ?? item.assessment ?? 0;
      const saleType = item.saleType ?? item.modalidade ?? item.type ?? '';
      const urlSlug = item.url ?? item.slug ?? '';

      // Imagens
      const imagens: string[] = [];
      if (item.photos && Array.isArray(item.photos)) {
        for (const p of item.photos) {
          const src = typeof p === 'string' ? p : (p.url ?? p.src ?? '');
          if (src) imagens.push(src);
        }
      } else if (item.image || item.imageUrl) {
        imagens.push(item.image ?? item.imageUrl);
      }

      const { tipo, ocupado, area, cidade, estado } = parsearTitulo(titulo);

      // Filtrar apenas Uberlândia/MG
      if (estado !== 'MG') continue;
      if (!cidade.toUpperCase().includes('UBERLÂNDIA') &&
          !cidade.toUpperCase().includes('UBERLANDIA') &&
          !cidade.toUpperCase().includes('UBERL')) continue;

      const valorMinimo = typeof preco === 'number' ? preco : extrairValor(String(preco));
      if (valorMinimo === 0) continue;

      const valorAvaliacao = typeof avaliacaoApi === 'number' && avaliacaoApi > 0
        ? avaliacaoApi
        : valorMinimo;

      const urlFonte = urlSlug
        ? (urlSlug.startsWith('http') ? urlSlug : `${BASE_URL}/oferta/${urlSlug}`)
        : `${BASE_URL}/oferta/${id}`;

      // Data de encerramento
      let dataLeilao: Date | undefined;
      const endDate = item.endDate ?? item.dataFim ?? item.expirationDate ?? item.closingDate;
      if (endDate) {
        const d = new Date(endDate);
        if (!isNaN(d.getTime())) dataLeilao = d;
      }

      results.push({
        codigoFonte: `sold-${id}`,
        urlFonte,
        tipo,
        modalidade: normalizarModalidade(saleType),
        estado: 'MG',
        cidade: 'Uberlândia',
        bairro: item.neighborhood ?? item.bairro ?? undefined,
        endereco: item.address ?? item.endereco ?? undefined,
        valorAvaliacao,
        valorMinimo,
        areaTotal: area ?? item.area ?? item.totalArea ?? undefined,
        ocupado,
        imagens,
        dataLeilao,
      });
    } catch {
      // ignora itens mal formados
    }
  }

  return results;
}

// ── extrator de imóveis do DOM (fallback) ─────────────────────

async function parsearDOM(page: any): Promise<ImovelRaw[]> {
  // O DOM do Superbid usa classes geradas (styled-components) — instáveis.
  // Usamos seletores semânticos mais robustos.
  const results: ImovelRaw[] = [];

  try {
    // Espera algum card aparecer
    await page.waitForSelector('a[href*="/oferta/"]', { timeout: 15000 }).catch(() => {});

    const cards = await page.$$('a[href*="/oferta/"]');
    if (!cards.length) return results;

    for (const card of cards) {
      try {
        const href = await card.getAttribute('href') || '';
        const urlFonte = href.startsWith('http') ? href : `${BASE_URL}${href}`;

        // ID da oferta: /oferta/nome-do-imovel-12345 → 12345
        const idMatch = href.match(/-(\d+)\s*$/) || href.match(/\/oferta\/.*?(\d+)\s*$/);
        const id = idMatch ? idMatch[1] : '';
        if (!id) continue;

        // Texto completo do card
        const texto = (await card.innerText() || '').trim();
        const linhas = texto.split('\n').map((l: string) => l.trim()).filter(Boolean);

        // Linha do título: normalmente a primeira linha não vazia
        const titulo = linhas[0] || '';
        const { tipo, ocupado, area, cidade, estado } = parsearTitulo(titulo);

        // Filtrar UberIândia/MG
        if (estado !== 'MG') continue;
        if (!cidade.toUpperCase().includes('UBERLÂNDIA') &&
            !cidade.toUpperCase().includes('UBERLANDIA') &&
            !cidade.toUpperCase().includes('UBERL')) continue;

        // Valor: busca "R$" no texto
        const valorTexto = linhas.find((l: string) => l.includes('R$')) || '';
        const valorMinimo = extrairValor(valorTexto);
        if (valorMinimo === 0) continue;

        // Modalidade: "Mercado Balcão", "Leilão", etc.
        const modalidadeTexto = linhas.find((l: string) =>
          l.includes('Leilão') || l.includes('Balcão') || l.includes('Direta')) || '';

        // Imagem
        const img = await card.$('img');
        const imagemUrl = img ? (await img.getAttribute('src') || '') : '';
        const imagens = imagemUrl ? [imagemUrl] : [];

        results.push({
          codigoFonte: `sold-${id}`,
          urlFonte,
          tipo,
          modalidade: normalizarModalidade(modalidadeTexto),
          estado: 'MG',
          cidade: 'Uberlândia',
          valorAvaliacao: valorMinimo, // sem avaliação no card
          valorMinimo,
          areaTotal: area,
          ocupado,
          imagens,
        });
      } catch {
        // ignora card com erro
      }
    }
  } catch {
    // timeout ou sem cards
  }

  return results;
}

// ── scraper principal ─────────────────────────────────────────

async function scrapePaginas(): Promise<ImovelRaw[]> {
  const imoveis: ImovelRaw[] = [];
  const vistos = new Set<string>();

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'pt-BR',
      viewport: { width: 1366, height: 768 },
    });

    const page = await context.newPage();

    // Interceptar respostas JSON da API do Superbid
    const apiData: any[] = [];
    let totalItems = 0;

    page.on('response', async (response) => {
      try {
        const url = response.url();
        if (
          response.status() === 200 &&
          (url.includes('offer-panel.superbid.net') || url.includes('api.s4bdigital.net')) &&
          (url.includes('/lots') || url.includes('/offers') || url.includes('/search') || url.includes('/items'))
        ) {
          const ct = response.headers()['content-type'] || '';
          if (ct.includes('application/json')) {
            const json = await response.json();
            apiData.push(json);

            // Tenta capturar total de itens para calcular páginas
            const t = json?.totalElements ?? json?.total ?? json?.count ?? json?.totalItems ?? 0;
            if (t > totalItems) totalItems = t;
          }
        }
      } catch {
        // ignora falhas na interceptação
      }
    });

    console.log('[SOLD] ── MG / UBERLANDIA ──────────────────');

    // Página 1 para calibrar total
    await page.goto(listingUrl(1), { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Se a API respondeu com dados, usa eles; caso contrário DOM
    let usandoAPI = false;

    if (apiData.length > 0) {
      usandoAPI = true;
      for (const json of apiData) {
        const itens = parsearRespostaAPI(json);
        for (const im of itens) {
          if (!vistos.has(im.codigoFonte)) {
            vistos.add(im.codigoFonte);
            imoveis.push(im);
          }
        }
      }
    } else {
      const domItens = await parsearDOM(page);
      for (const im of domItens) {
        if (!vistos.has(im.codigoFonte)) {
          vistos.add(im.codigoFonte);
          imoveis.push(im);
        }
      }
    }

    console.log(`  Página 1: ${imoveis.length} itens${usandoAPI ? ' (via API)' : ' (via DOM)'}`);

    // Calcular total de páginas
    let totalPaginas = 1;
    if (totalItems > PAGE_SIZE) {
      totalPaginas = Math.ceil(totalItems / PAGE_SIZE);
    } else if (usandoAPI) {
      // Sem total conhecido — tenta até sem resultados
      totalPaginas = 10;
    }

    // Páginas restantes
    for (let p = 2; p <= totalPaginas; p++) {
      apiData.length = 0; // limpa buffer

      await page.goto(listingUrl(p), { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(2000);

      let novosNestaPagina = 0;

      if (usandoAPI && apiData.length > 0) {
        for (const json of apiData) {
          const itens = parsearRespostaAPI(json);
          for (const im of itens) {
            if (!vistos.has(im.codigoFonte)) {
              vistos.add(im.codigoFonte);
              imoveis.push(im);
              novosNestaPagina++;
            }
          }
        }
      } else {
        const domItens = await parsearDOM(page);
        for (const im of domItens) {
          if (!vistos.has(im.codigoFonte)) {
            vistos.add(im.codigoFonte);
            imoveis.push(im);
            novosNestaPagina++;
          }
        }
      }

      console.log(`  Página ${p}/${totalPaginas}: +${novosNestaPagina}`);

      // Se chegou sem resultados, para
      if (novosNestaPagina === 0) break;
    }
  } finally {
    await browser.close();
  }

  return imoveis;
}

export async function scraperSold(): Promise<ScraperResult> {
  const erros: string[] = [];
  let imoveis: ImovelRaw[] = [];

  console.log('[SOLD] Iniciando scraper...');

  try {
    imoveis = await scrapePaginas();
    for (const im of imoveis) {
      console.log(`  ✓ ${im.tipo} | ${im.bairro || 'Uberlândia'} | mín: R$${im.valorMinimo.toLocaleString('pt-BR')}`);
    }
  } catch (err: any) {
    const msg = `[SOLD] Erro geral: ${err.message}`;
    console.error(msg);
    erros.push(msg);
  }

  console.log(`\n[SOLD] Total: ${imoveis.length} imóveis, ${erros.length} erros`);
  return { imoveis, erros };
}
