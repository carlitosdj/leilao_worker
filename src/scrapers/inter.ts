/**
 * Scraper — Banco Inter (imoveis.bancointer.com.br)
 *
 * API REST com OAuth2 client_credentials (credenciais públicas no frontend).
 * Portfólio pequeno (~22 imóveis nacionais). Filtra apenas Uberlândia/MG pós-API.
 *
 * Estratégia:
 * 1. POST /token → Bearer token (expira em 1h)
 * 2. POST /publicacoes (sem filtro de cidade) → 10 imóveis/página
 * 3. Paginação via cursor _scroll (base64 JSON, POST text/plain)
 * 4. Filtrar resultados por cidade === 'UBERLANDIA' && estado === 'MG'
 */

import axios from 'axios';
import { ImovelRaw, ScraperResult } from './types';

const API_BASE = 'https://ci-api.bancointer.com.br/imoveis-inter';
const CLIENT_ID = '1804268e-0544-43d8-b6b2-11751e6a3ca9';
const CLIENT_SECRET = '85050350-bd69-4336-b9ca-786c10b29cfc';

const http = axios.create({ timeout: 30000 });

// ── autenticação ──────────────────────────────────────────────

async function getToken(): Promise<string> {
  const resp = await http.post(
    `${API_BASE}/token`,
    `client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials&scope=CI-API%20CI-TURBO`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return resp.data.access_token as string;
}

// ── normalizadores ────────────────────────────────────────────

function normalizarTipo(tipoImovel: string): ImovelRaw['tipo'] {
  const t = (tipoImovel || '').toLowerCase();
  if (t.includes('apart') || t.includes('flat') || t.includes('studio') || t.includes('kitnet') || t.includes('sala_ap')) return 'apartamento';
  if (t.includes('casa') || t.includes('sobrado') || t.includes('chacara') || t.includes('rural_residencial')) return 'casa';
  if (t.includes('terreno') || t.includes('lote') || t.includes('gleba')) return 'terreno';
  if (t.includes('comercial') || t.includes('sala') || t.includes('loja') || t.includes('galpao') || t.includes('predio')) return 'comercial';
  if (t.includes('rural') || t.includes('sitio') || t.includes('fazenda')) return 'rural';
  return 'outro';
}

// ── scraper principal ─────────────────────────────────────────

export async function scraperInter(): Promise<ScraperResult> {
  const imoveis: ImovelRaw[] = [];
  const erros: string[] = [];

  console.log('[Inter] Iniciando scraper...');
  console.log('[Inter] ── MG / UBERLANDIA ──────────────────');

  try {
    const token = await getToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    // Primeira página (sem filtro — portfólio pequeno)
    const body = {
      estados: null, cidades: null, bairros: null,
      valorMinimo: null, valorMaximo: null,
      ocupado: null, tiposImovel: null,
      quantidadeQuartos: null, quantidadeBanheiros: null,
      quantidadeSuites: null, quantidadeVagasGaragem: null,
      areaTotalMinimo: null, areaTotalMaximo: null,
      possuiLeilao: null, codigo: null,
    };

    let resp = await http.post(`${API_BASE}/v1/publicacoes`, body, { headers });
    let page = 1;
    let totalProcessados = 0;

    while (true) {
      const publicacoes: any[] = resp.data.publicacoes || [];
      if (publicacoes.length === 0) break;

      for (const pub of publicacoes) {
        totalProcessados++;
        const im = pub.imovel || {};
        const cidade: string = (im.enderecoCidade || '').toUpperCase();
        const estado: string = (im.enderecoEstado || '').toUpperCase();

        // Filtrar apenas Uberlândia/MG
        if (!cidade.includes('UBERLÂNDIA') && !cidade.includes('UBERLANDIA')) continue;
        if (estado !== 'MG') continue;

        const valorMinimo: number = pub.valor || im.valor || 0;
        const valorAvaliacao: number = im.valor || valorMinimo;

        const imagens: string[] = (im.imagens || [])
          .map((img: any) => img.url || '')
          .filter(Boolean);

        const endereco = [
          im.enderecoLogradouro,
          im.enderecoNumero,
          im.enderecoComplemento,
        ].filter(Boolean).join(', ');

        const im_: ImovelRaw = {
          codigoFonte: `inter-${pub.id || im.id || im.codigo}`,
          urlFonte: `https://imoveis.bancointer.com.br/imovel/${pub.id}`,
          tipo: normalizarTipo(im.tipoImovel || ''),
          modalidade: (im.leiloes && im.leiloes.length > 0) ? 'segundo_leilao' : 'venda_direta',
          estado: 'MG',
          cidade: 'Uberlândia',
          bairro: im.enderecoBairro || undefined,
          endereco: endereco || undefined,
          cep: im.enderecoCep ? String(im.enderecoCep).padStart(8, '0') : undefined,
          valorAvaliacao,
          valorMinimo,
          areaTotal: im.areaTotal || undefined,
          vagas: im.quantidadeVagasGaragem || undefined,
          ocupado: im.ocupado === false ? 'nao' : im.ocupado === true ? 'sim' : 'desconhecido',
          imagens,
        };

        imoveis.push(im_);

        const desconto = valorAvaliacao > 0
          ? ((valorAvaliacao - valorMinimo) / valorAvaliacao * 100).toFixed(1)
          : '0.0';
        console.log(`  ✓ ${im_.tipo} | ${im_.bairro || 'Uberlândia'} | mín: R$${valorMinimo.toLocaleString('pt-BR')} | ${desconto}% desc`);
      }

      // Paginação via _scroll
      const scroll: string = resp.data._scroll || '';
      if (!scroll || publicacoes.length === 0) break;

      page++;
      resp = await http.post(
        `${API_BASE}/v1/publicacoes/_scroll`,
        scroll,
        { headers: { ...headers, 'Content-Type': 'text/plain' } }
      );
    }

    console.log(`[Inter] Processados: ${totalProcessados} imóveis nacionais`);
  } catch (err: any) {
    const msg = `[Inter] Erro geral: ${err.message}`;
    console.error(msg);
    erros.push(msg);
  }

  console.log(`\n[Inter] Total: ${imoveis.length} imóveis em UDI, ${erros.length} erros`);
  return { imoveis, erros };
}
