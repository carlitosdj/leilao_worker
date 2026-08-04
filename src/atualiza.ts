import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env.local' });

import mysql from 'mysql2/promise';
import { scraperCaixa } from './scrapers/caixa';
import { scraperBancoBrasil } from './scrapers/bancoBrasil';
import { scraperZuk } from './scrapers/zuk';
import { scraperSold } from './scrapers/sold';
import { scraperSpy } from './scrapers/spy';
import { scraperLeiloesJudiciais } from './scrapers/leiloesJudiciais';
import { scraperBradesco } from './scrapers/bradesco';
import { scraperBiasi } from './scrapers/biasi';
import { scraperInter } from './scrapers/inter';
import { scraperSantander } from './scrapers/santander';
import { processarImoveis } from './jobs/processarImoveis';
import { geocodificarImovelSemCoordenadas } from './jobs/geocodificar';

const ALVO_CAIXA = { MG: ['UBERLANDIA'] };

function linha(char = '─', n = 50) { return char.repeat(n); }

interface Resultado { novos: number; atualizados: number; erros: number; }

async function runScraper(
  label: string,
  step: string,
  fonteSlug: string,
  fn: () => Promise<{ imoveis: any[]; erros: string[] }>,
  resultados: Record<string, Resultado>
) {
  console.log(`\n${step} ${label}...`);
  try {
    const { imoveis, erros } = await fn();
    if (imoveis.length > 0) {
      const stats = await processarImoveis(fonteSlug, imoveis);
      resultados[fonteSlug] = { ...stats, erros: erros.length };
    } else {
      resultados[fonteSlug] = { novos: 0, atualizados: 0, erros: erros.length };
    }
    const r = resultados[fonteSlug];
    console.log(`  ✓ ${label}: ${r.novos} novos | ${r.atualizados} atualizados | ${r.erros} erros`);
  } catch (err: any) {
    console.error(`  ✗ ${label} falhou: ${err.message}`);
    resultados[fonteSlug] = { novos: 0, atualizados: 0, erros: 1 };
  }
}

async function main() {
  console.log(linha('━'));
  console.log('  Atualização — Imóveis de Uberlândia');
  console.log(linha('━'));

  const resultados: Record<string, Resultado> = {};

  // ── Scrapers: do mais simples/rápido ao mais pesado ──────────
  await runScraper('Spy Leilões',        '[1/10]', 'spy',      scraperSpy,               resultados);
  await runScraper('Leilões Judiciais',  '[2/10]', 'lj',       scraperLeiloesJudiciais,  resultados);
  await runScraper('Portal ZUK',         '[3/10]', 'zuk',      scraperZuk,               resultados);
  await runScraper('Biasi Leilões',      '[4/10]', 'biasi',     scraperBiasi,             resultados);
  await runScraper('Santander',          '[5/10]', 'santander', scraperSantander,         resultados);
  await runScraper('Caixa Econômica',    '[6/10]', 'caixa',     () => scraperCaixa(ALVO_CAIXA), resultados);
  await runScraper('Banco do Brasil',    '[7/10]', 'bb',        scraperBancoBrasil,       resultados);
  await runScraper('SOLD / Superbid',    '[8/10]', 'sold',      scraperSold,              resultados);
  await runScraper('Bradesco',           '[9/10]', 'bradesco',  scraperBradesco,          resultados);
  await runScraper('Banco Inter',        '[10/10]', 'inter',    scraperInter,             resultados);

  // ── Geocodificação em lote ────────────────────────────────────
  console.log(`\n${linha()}`);
  console.log('[Geo] Geocodificando imóveis sem coordenadas...');

  const pool = mysql.createPool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME     || 'leilaodb',
    user:     process.env.DB_USER     || 'leilao',
    password: process.env.DB_PASSWORD || '',
    waitForConnections: true,
    connectionLimit: 3,
  });
  await geocodificarImovelSemCoordenadas(pool, 100);
  await pool.end();

  // ── Resumo ────────────────────────────────────────────────────
  const totalNovos    = Object.values(resultados).reduce((s, r) => s + r.novos, 0);
  const totalAtualizados = Object.values(resultados).reduce((s, r) => s + r.atualizados, 0);

  console.log(`\n${linha('━')}`);
  console.log('  Resumo final');
  console.log(linha('━'));
  for (const [slug, r] of Object.entries(resultados)) {
    console.log(`  ${slug.padEnd(14)} → ${String(r.novos).padStart(4)} novos | ${String(r.atualizados).padStart(4)} atualiz | ${r.erros} erros`);
  }
  console.log(linha());
  console.log(`  Total: ${totalNovos} novos + ${totalAtualizados} atualizados`);
  console.log(linha('━'));

  process.exit(0);
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
