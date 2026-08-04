import axios from 'axios';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { ImovelRaw, ScraperResult } from './types';

/**
 * Scraper — Banco do Brasil (Licitação de Imóveis)
 * Portal: https://www8.bb.com.br/licitacaoimoveis/
 *
 * Fluxo:
 * 1. Abre a página de listagem
 * 2. Seleciona estado MG e cidade Uberlândia
 * 3. Percorre todas as páginas
 * 4. Extrai os dados de cada imóvel
 */

const BASE_URL = 'https://www8.bb.com.br/licitacaoimoveis';
const LISTA_URL = `${BASE_URL}/listarImoveis.bb`;

const http = axios.create({
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': LISTA_URL,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9',
  },
});

function normalizarTipo(texto: string): ImovelRaw['tipo'] {
  const t = texto.toLowerCase();
  if (t.includes('apart') || t.includes('apto') || t.includes('kitnet') || t.includes('flat')) return 'apartamento';
  if (t.includes('casa') || t.includes('sobrado') || t.includes('chácara') || t.includes('chacara')) return 'casa';
  if (t.includes('terreno') || t.includes('lote') || t.includes('gleba')) return 'terreno';
  if (t.includes('comercial') || t.includes('sala') || t.includes('loja') || t.includes('galpão') || t.includes('galpao')) return 'comercial';
  if (t.includes('rural') || t.includes('sítio') || t.includes('sitio') || t.includes('fazenda')) return 'rural';
  return 'outro';
}

function normalizarModalidade(texto: string): ImovelRaw['modalidade'] {
  const t = texto.toLowerCase();
  if (t.includes('2ª') || t.includes('segunda') || t.includes('2a')) return 'segundo_leilao';
  if (t.includes('1ª') || t.includes('primeira') || t.includes('1a')) return 'primeiro_leilao';
  if (t.includes('licitação') || t.includes('licitacao')) return 'licitacao';
  return 'venda_direta';
}

function extrairValor(texto: string): number {
  const limpo = texto.replace(/\./g, '').replace(',', '.');
  const match = limpo.match(/[\d]+\.?\d*/);
  return match ? parseFloat(match[0]) : 0;
}

function extrairArea(texto: string): number | undefined {
  const match = texto.match(/([\d.,]+)\s*m[²2]/i);
  if (!match) return undefined;
  return parseFloat(match[1].replace('.', '').replace(',', '.'));
}

interface ImovelBB {
  codigo: string;
  urlDetalhe: string;
  tipo: string;
  endereco: string;
  bairro: string;
  modalidade: ImovelRaw['modalidade'];
  valorAvaliacao: number;
  valorMinimo: number;
  areaTotal?: number;
  imagens: string[];
  dataLeilao?: Date;
}

function parsearListagem(html: string): ImovelBB[] {
  const $ = cheerio.load(html);
  const itens: ImovelBB[] = [];

  // O BB usa uma tabela com class "resultados" ou divs com class "item-imovel"
  // Tentamos múltiplos seletores para maior robustez
  const linhas = $('table.resultados tr[class*="item"], .item-imovel, tr.linha-resultado');

  if (linhas.length === 0) {
    // Fallback: tentar todas as linhas de tabela com links
    $('table tr').each((_, el) => {
      const cols = $(el).find('td');
      if (cols.length < 3) return;

      const link = $(el).find('a').first();
      const href = link.attr('href') || '';
      if (!href) return;

      const codigoMatch = href.match(/indImovel=(\w+)/i) || href.match(/codigo=(\w+)/i) || href.match(/id=(\w+)/i);
      const codigo = codigoMatch ? codigoMatch[1] : `bb-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const textos = cols.map((_, td) => $(td).text().trim()).get();
      const textoCompleto = textos.join(' ');

      let valorAvaliacao = 0;
      let valorMinimo = 0;

      // Procura valores em células específicas
      cols.each((i, td) => {
        const txt = $(td).text();
        if (txt.includes('R$') || txt.match(/[\d]{3,}/)) {
          const v = extrairValor(txt);
          if (v > 1000) {
            if (valorAvaliacao === 0) valorAvaliacao = v;
            else if (valorMinimo === 0) valorMinimo = v;
          }
        }
      });

      if (valorAvaliacao === 0 && valorMinimo === 0) return;
      if (valorMinimo === 0) valorMinimo = valorAvaliacao;

      const urlDetalhe = href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;

      itens.push({
        codigo,
        urlDetalhe,
        tipo: normalizarTipo(textoCompleto),
        endereco: textos[1] || '',
        bairro: textos[2] || '',
        modalidade: normalizarModalidade(textoCompleto),
        valorAvaliacao,
        valorMinimo,
        areaTotal: extrairArea(textoCompleto),
        imagens: [],
      });
    });

    return itens;
  }

  linhas.each((_, el) => {
    const $el = $(el);
    const link = $el.find('a').first();
    const href = link.attr('href') || '';

    const codigoMatch = href.match(/indImovel=(\w+)/i) || href.match(/codigo=(\w+)/i);
    const codigo = codigoMatch ? codigoMatch[1] : `bb-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const urlDetalhe = href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;

    const textoCompleto = $el.text();

    // Valores de avaliação e mínimo
    let valorAvaliacao = 0;
    let valorMinimo = 0;

    const avEl = $el.find('.valor-avaliacao, .vl-avaliacao, [class*="avaliacao"]').first();
    const minEl = $el.find('.valor-minimo, .vl-minimo, [class*="minimo"], [class*="venda"]').first();

    if (avEl.length) valorAvaliacao = extrairValor(avEl.text());
    if (minEl.length) valorMinimo = extrairValor(minEl.text());

    // Fallback: pegar os dois primeiros valores R$ encontrados
    if (valorAvaliacao === 0) {
      const matches = textoCompleto.match(/R\$\s*[\d.,]+/g) || [];
      if (matches[0]) valorAvaliacao = extrairValor(matches[0]);
      if (matches[1]) valorMinimo = extrairValor(matches[1]);
    }

    if (valorAvaliacao === 0 && valorMinimo === 0) return;
    if (valorMinimo === 0) valorMinimo = valorAvaliacao;

    const endereco = $el.find('.endereco, [class*="enderec"]').text().trim()
      || $el.find('td').eq(1).text().trim()
      || '';

    const bairro = $el.find('.bairro, [class*="bairro"]').text().trim()
      || $el.find('td').eq(2).text().trim()
      || '';

    const modalidadeTexto = $el.find('.modalidade, [class*="modalidade"]').text()
      || $el.find('td').eq(0).text()
      || '';

    // Data do leilão
    let dataLeilao: Date | undefined;
    const dataMatch = textoCompleto.match(/(\d{2}\/\d{2}\/\d{4})/);
    if (dataMatch) {
      const [d, m, a] = dataMatch[1].split('/');
      const dt = new Date(`${a}-${m}-${d}`);
      if (!isNaN(dt.getTime())) dataLeilao = dt;
    }

    // Imagens
    const imagens: string[] = [];
    $el.find('img[src*="/fotos/"], img[src*=".jpg"], img[src*=".jpeg"]').each((_, img) => {
      const src = $(img).attr('src') || '';
      if (src && !src.includes('semfoto') && !src.includes('logo')) {
        imagens.push(src.startsWith('http') ? src : `${BASE_URL}${src}`);
      }
    });

    itens.push({
      codigo,
      urlDetalhe,
      tipo: normalizarTipo(textoCompleto),
      endereco,
      bairro,
      modalidade: normalizarModalidade(modalidadeTexto),
      valorAvaliacao,
      valorMinimo,
      areaTotal: extrairArea(textoCompleto),
      imagens,
      dataLeilao,
    });
  });

  return itens;
}

async function scrapeUberlandiaBB(): Promise<ImovelRaw[]> {
  const imoveis: ImovelRaw[] = [];

  console.log('\n[BB] ── MG / UBERLANDIA ──────────────────');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'pt-BR',
    });
    const page = await context.newPage();

    await page.goto(LISTA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Selecionar estado MG
    const estadoSel = page.locator('select[name="sltEstado"], #sltEstado, select[id*="estado"], select[name*="estado"]').first();
    if (await estadoSel.count() > 0) {
      await estadoSel.selectOption({ value: 'MG' });
      await page.waitForTimeout(2000);
    } else {
      console.log('[BB] Select de estado não encontrado — tentando direto via POST');
    }

    // Selecionar cidade Uberlândia (BB usa código numérico ou nome)
    const cidadeSel = page.locator('select[name="sltCidade"], #sltCidade, select[id*="cidade"], select[name*="cidade"]').first();
    let cidadeId = '';
    if (await cidadeSel.count() > 0) {
      const options = await cidadeSel.locator('option').all();
      for (const opt of options) {
        const txt = (await opt.textContent() || '').toUpperCase();
        if (txt.includes('UBERLANDIA') || txt.includes('UBERLÂNDIA')) {
          cidadeId = await opt.getAttribute('value') || '';
          break;
        }
      }
      if (cidadeId) {
        await cidadeSel.selectOption(cidadeId);
        await page.waitForTimeout(1000);
      } else {
        console.log('[BB] Cidade Uberlândia não encontrada no select');
      }
    }

    // Submeter o formulário de busca
    const btnBuscar = page.locator('input[type="submit"], button[type="submit"], button:has-text("Buscar"), a:has-text("Pesquisar")').first();
    if (await btnBuscar.count() > 0) {
      await btnBuscar.click();
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // Parsear página inicial
    let pagina = 1;
    let hasNext = true;

    while (hasNext) {
      const html = await page.content();
      const itens = parsearListagem(html);
      console.log(`  Página ${pagina}: ${itens.length} itens`);

      for (const item of itens) {
        if (!item.codigo || (item.valorAvaliacao === 0 && item.valorMinimo === 0)) continue;

        imoveis.push({
          codigoFonte: `bb-${item.codigo}`,
          urlFonte: item.urlDetalhe,
          tipo: normalizarTipo(item.tipo),
          modalidade: item.modalidade,
          estado: 'MG',
          cidade: 'Uberlândia',
          bairro: item.bairro || undefined,
          endereco: item.endereco || undefined,
          valorAvaliacao: item.valorAvaliacao,
          valorMinimo: item.valorMinimo,
          areaTotal: item.areaTotal,
          imagens: item.imagens,
          dataLeilao: item.dataLeilao,
        });

        console.log(`  ✓ ${normalizarTipo(item.tipo)} | ${item.bairro || 'Uberlândia'} | av: R$${item.valorAvaliacao.toLocaleString('pt-BR')} | mín: R$${item.valorMinimo.toLocaleString('pt-BR')}`);
      }

      // Próxima página
      const nextBtn = page.locator('a:has-text("Próxima"), a:has-text("Próximo"), a[href*="indPage"][href*="proxima"], .pagina-proxima a, a.prox').first();
      if (await nextBtn.count() > 0) {
        await nextBtn.click();
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1500);
        pagina++;
      } else {
        hasNext = false;
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`[BB] MG/UBERLANDIA → ${imoveis.length} imóveis`);
  return imoveis;
}

export async function scraperBancoBrasil(): Promise<ScraperResult> {
  const erros: string[] = [];
  let imoveis: ImovelRaw[] = [];

  console.log('[BB] Iniciando scraper...');

  try {
    imoveis = await scrapeUberlandiaBB();
  } catch (err: any) {
    const msg = `[BB] Erro geral: ${err.message}`;
    console.error(msg);
    erros.push(msg);
  }

  console.log(`\n[BB] Total: ${imoveis.length} imóveis, ${erros.length} erros`);
  return { imoveis, erros };
}
