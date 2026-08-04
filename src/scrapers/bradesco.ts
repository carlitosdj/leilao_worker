/**
 * Scraper — Bradesco Patrimônio (portalpatrimonio.bradesco.com.br)
 *
 * Estratégia:
 * 1. Playwright carrega o SPA React do portal
 * 2. Intercepta chamadas XHR/fetch para capturar o JSON da API interna
 * 3. Filtra por estado=MG e cidade contendo Uberlândia
 * 4. Fallback: parsing do DOM com seletores semânticos se a API não for capturada
 *
 * Nota: o portal retorna 403 para axios direto — requer browser para contornar WAF.
 */

import { chromium } from 'playwright';
import { ImovelRaw, ScraperResult } from './types';

const BASE_URL = 'https://portalpatrimonio.bradesco.com.br';

// URLs candidatas de busca no portal Bradesco
const SEARCH_URLS = [
  `${BASE_URL}/imoveis/venda?estado=MG&cidade=Uberlândia`,
  `${BASE_URL}/imoveis?estado=MG&cidade=Uberlândia`,
  `${BASE_URL}/leilao/imoveis?estado=MG&cidade=Uberlândia`,
  `${BASE_URL}/imoveis/busca?estado=MG&municipio=Uberlândia`,
];

// ── normalizadores ────────────────────────────────────────────

function normalizarTipo(texto: string): ImovelRaw['tipo'] {
  const t = texto.toLowerCase();
  if (t.includes('apart') || t.includes('apto') || t.includes('kitnet') || t.includes('flat')) return 'apartamento';
  if (t.includes('casa') || t.includes('sobrado') || t.includes('chácara')) return 'casa';
  if (t.includes('terreno') || t.includes('lote') || t.includes('gleba')) return 'terreno';
  if (t.includes('comercial') || t.includes('sala') || t.includes('loja') || t.includes('galpão')) return 'comercial';
  if (t.includes('rural') || t.includes('sítio') || t.includes('fazenda')) return 'rural';
  return 'outro';
}

function normalizarModalidade(texto: string): ImovelRaw['modalidade'] {
  const t = texto.toLowerCase();
  if (t.includes('2ª') || t.includes('segundo')) return 'segundo_leilao';
  if (t.includes('1ª') || t.includes('primeiro')) return 'primeiro_leilao';
  if (t.includes('venda direta') || t.includes('particular')) return 'venda_direta';
  return 'licitacao';
}

function extrairValor(texto: string | number): number {
  if (typeof texto === 'number') return texto;
  const limpo = String(texto).replace(/\./g, '').replace(',', '.');
  const m = limpo.match(/[\d]+\.?\d*/);
  return m ? parseFloat(m[0]) : 0;
}

function extrairArea(texto: string): number | undefined {
  const m = String(texto).match(/([\d.,]+)\s*m[²2]/i);
  if (!m) return undefined;
  const v = parseFloat(m[1].replace('.', '').replace(',', '.'));
  return isNaN(v) ? undefined : v;
}

// ── parser de resposta JSON da API ───────────────────────────

function parsearRespostaJSON(json: any): ImovelRaw[] {
  const results: ImovelRaw[] = [];

  // Tentar extrair array de imóveis de diferentes estruturas possíveis
  const lista: any[] =
    json?.imoveis || json?.data?.imoveis ||
    json?.items || json?.data?.items ||
    json?.content || json?.data?.content ||
    json?.properties || json?.data ||
    (Array.isArray(json) ? json : []);

  if (!lista.length) return results;

  for (const item of lista) {
    try {
      // Campos possíveis na API do Bradesco
      const id = item.id || item.codigo || item.codImovel || item.cod;
      if (!id) continue;

      // Cidade/estado — filtrar só Uberlândia/MG
      const cidade = (item.cidade || item.municipio || item.city || '').toString().toUpperCase();
      const estado = (item.estado || item.uf || item.state || '').toString().toUpperCase();

      if (estado !== 'MG') continue;
      if (!cidade.includes('UBERLÂNDIA') && !cidade.includes('UBERLANDIA') && !cidade.includes('UBERL')) continue;

      const tipo = normalizarTipo(
        item.tipo || item.tipologia || item.type || item.descricaoTipo || ''
      );

      const modalidade = normalizarModalidade(
        item.modalidade || item.tipoVenda || item.category || ''
      );

      const endereco = [
        item.logradouro || item.endereco || item.address || '',
        item.numero ? `nº ${item.numero}` : '',
        item.bairro || item.neighborhood || '',
      ].filter(Boolean).join(', ');

      const valorAvaliacao = extrairValor(
        item.valorAvaliacao || item.avaliacao || item.valorMercado || item.marketValue || 0
      );
      const valorMinimo = extrairValor(
        item.valorMinimo || item.valorVenda || item.precoMinimo || item.minimumBid || item.price || 0
      );

      if (valorMinimo === 0 && valorAvaliacao === 0) continue;

      // Imagens
      const imagens: string[] = [];
      const fotosSrc = item.fotos || item.photos || item.images || item.imagens || [];
      for (const f of fotosSrc) {
        const src = typeof f === 'string' ? f : (f.url || f.src || f.path || '');
        if (src) imagens.push(src.startsWith('http') ? src : `${BASE_URL}${src}`);
      }
      if (item.foto || item.photo || item.image) {
        const src = item.foto || item.photo || item.image;
        if (typeof src === 'string') imagens.unshift(src.startsWith('http') ? src : `${BASE_URL}${src}`);
      }

      // Data do leilão
      let dataLeilao: Date | undefined;
      const dataStr = item.dataLeilao || item.dataEvento || item.auctionDate || item.date || '';
      if (dataStr) {
        const d = new Date(dataStr);
        if (!isNaN(d.getTime())) dataLeilao = d;
      }

      const urlFonte = item.url || item.link || item.urlDetalhe
        ? (item.url || item.link || item.urlDetalhe).startsWith('http')
          ? (item.url || item.link || item.urlDetalhe)
          : `${BASE_URL}${item.url || item.link || item.urlDetalhe}`
        : `${BASE_URL}/imovel/${id}`;

      results.push({
        codigoFonte: `bradesco-${id}`,
        urlFonte,
        tipo,
        modalidade,
        estado: 'MG',
        cidade: 'Uberlândia',
        bairro: item.bairro || item.neighborhood || undefined,
        endereco: endereco || undefined,
        valorAvaliacao: valorAvaliacao > 0 ? valorAvaliacao : valorMinimo,
        valorMinimo: valorMinimo > 0 ? valorMinimo : valorAvaliacao,
        areaTotal: extrairArea(String(item.area || item.areaTotal || item.totalArea || '')),
        quartos: item.quartos || item.dormitorios || item.bedrooms || undefined,
        vagas: item.vagas || item.garagem || item.parkingSpaces || undefined,
        imagens,
        dataLeilao,
      });
    } catch {
      // ignora item mal formado
    }
  }

  return results;
}

// ── parser de DOM (fallback) ─────────────────────────────────

async function parsearDOM(page: any): Promise<ImovelRaw[]> {
  const results: ImovelRaw[] = [];
  try {
    // Esperar algum card aparecer
    await page.waitForSelector('[class*="imovel"], [class*="card"], [class*="property"]', { timeout: 15000 }).catch(() => {});

    // Tentar extrair dados de JSON-LD
    const jsonLds = await page.$$eval('script[type="application/ld+json"]', (els: any[]) =>
      els.map(el => { try { return JSON.parse(el.textContent || ''); } catch { return null; } }).filter(Boolean)
    );
    for (const jsonLd of jsonLds) {
      const parsed = parsearRespostaJSON(jsonLd);
      results.push(...parsed);
    }

    // Links de imóveis
    const links = await page.$$('a[href*="/imovel/"], a[href*="/imoveis/"]');
    for (const link of links.slice(0, 50)) {
      try {
        const href = await link.getAttribute('href') || '';
        const texto = await link.innerText() || '';

        if (!href || !texto) continue;

        const urlFonte = href.startsWith('http') ? href : `${BASE_URL}${href}`;
        const idMatch = href.match(/(\d{5,})/);
        if (!idMatch) continue;

        const valorMatch = texto.match(/R\$\s*([\d.,]+)/g);
        if (!valorMatch || valorMatch.length === 0) continue;

        const valorMinimo = extrairValor(valorMatch[0]);
        if (valorMinimo === 0) continue;

        // Filtrar Uberlândia
        if (!texto.toUpperCase().includes('UBERLÂNDIA') && !texto.toUpperCase().includes('UBERLANDIA')) continue;

        results.push({
          codigoFonte: `bradesco-${idMatch[1]}`,
          urlFonte,
          tipo: normalizarTipo(texto),
          modalidade: normalizarModalidade(texto),
          estado: 'MG',
          cidade: 'Uberlândia',
          valorAvaliacao: valorMinimo,
          valorMinimo,
          imagens: [],
        });
      } catch {
        // ignora
      }
    }
  } catch {
    // timeout
  }
  return results;
}

// ── scraper principal ─────────────────────────────────────────

export async function scraperBradesco(): Promise<ScraperResult> {
  const imoveis: ImovelRaw[] = [];
  const erros: string[] = [];

  console.log('[Bradesco] Iniciando scraper...');

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

    // Interceptar respostas JSON da API
    const apiData: any[] = [];
    page.on('response', async (response) => {
      try {
        if (response.status() !== 200) return;
        const ct = response.headers()['content-type'] || '';
        if (!ct.includes('application/json')) return;
        const url = response.url();
        if (
          url.includes('/imovel') || url.includes('/property') ||
          url.includes('/busca') || url.includes('/search') ||
          url.includes('/api/')
        ) {
          const json = await response.json();
          apiData.push({ url, json });
        }
      } catch {
        // ignora
      }
    });

    // Tentar cada URL de busca
    let encontrou = false;
    for (const url of SEARCH_URLS) {
      console.log(`[Bradesco] Tentando: ${url}`);
      try {
        const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
        if (!resp || resp.status() >= 400) {
          console.log(`[Bradesco]   → HTTP ${resp?.status() ?? '?'} — pulando`);
          continue;
        }
        await page.waitForTimeout(3000);
        encontrou = true;
        break;
      } catch (err: any) {
        console.log(`[Bradesco]   → Erro: ${err.message} — pulando`);
      }
    }

    if (!encontrou) {
      // Tentar URL raiz e navegar manualmente
      try {
        await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(2000);
        encontrou = true;
      } catch {
        // ignora
      }
    }

    // Processar dados capturados via API
    if (apiData.length > 0) {
      console.log(`[Bradesco] ${apiData.length} respostas de API capturadas`);
      for (const { url: apiUrl, json } of apiData) {
        const parsed = parsearRespostaJSON(json);
        if (parsed.length > 0) {
          console.log(`[Bradesco] ${parsed.length} imóveis da API: ${apiUrl}`);
          imoveis.push(...parsed);
        }
      }
    }

    // Fallback: DOM parsing
    if (imoveis.length === 0 && encontrou) {
      console.log('[Bradesco] Tentando extração do DOM...');
      const domImoveis = await parsearDOM(page);
      imoveis.push(...domImoveis);
    }

    for (const im of imoveis) {
      console.log(`  ✓ ${im.tipo} | ${im.bairro || 'Uberlândia'} | mín: R$${im.valorMinimo.toLocaleString('pt-BR')}`);
    }
  } catch (err: any) {
    const msg = `[Bradesco] Erro geral: ${err.message}`;
    console.error(msg);
    erros.push(msg);
  } finally {
    await browser.close();
  }

  console.log(`\n[Bradesco] Total: ${imoveis.length} imóveis, ${erros.length} erros`);
  return { imoveis, erros };
}
