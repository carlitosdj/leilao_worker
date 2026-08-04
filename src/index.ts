import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env.local' });

import cron from 'node-cron';
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

async function tryRun(label: string, fonteSlug: string, fn: () => Promise<{ imoveis: any[]; erros: string[] }>) {
  try {
    const { imoveis, erros } = await fn();
    if (imoveis.length > 0) await processarImoveis(fonteSlug, imoveis);
    if (erros.length > 0) console.warn(`[Worker] ${label}: ${erros.length} erros`);
  } catch (err: any) {
    console.error(`[Worker] ${label} falhou:`, err.message);
  }
}

async function runAtualizacao() {
  console.log(`\n[Worker] ══ Atualização iniciada ${new Date().toLocaleString('pt-BR')} ══`);

  await tryRun('Spy Leilões',       'spy',      scraperSpy);
  await tryRun('Leilões Judiciais', 'lj',       scraperLeiloesJudiciais);
  await tryRun('ZUK',               'zuk',      scraperZuk);
  await tryRun('Biasi Leilões',     'biasi',    scraperBiasi);
  await tryRun('Santander',         'santander', scraperSantander);
  await tryRun('Caixa',             'caixa',    () => scraperCaixa(ALVO_CAIXA));
  await tryRun('Banco do Brasil',   'bb',       scraperBancoBrasil);
  await tryRun('SOLD',              'sold',     scraperSold);
  await tryRun('Bradesco',          'bradesco', scraperBradesco);
  await tryRun('Banco Inter',       'inter',    scraperInter);

  // Geocodificação em lote
  try {
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
  } catch (err: any) {
    console.error('[Worker] Geocodificação falhou:', err.message);
  }

  console.log(`[Worker] ══ Atualização concluída ${new Date().toLocaleString('pt-BR')} ══\n`);
}

// Rodar ao iniciar
runAtualizacao();

// Agendar: todo dia às 6h e 18h
cron.schedule('0 6,18 * * *', () => {
  runAtualizacao();
});

console.log('[Worker] Agendador iniciado. Próximas execuções: 06:00 e 18:00 diariamente.');
