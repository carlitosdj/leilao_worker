/**
 * Seed: garante que a tabela `fonte` tenha todas as fontes conhecidas.
 * Uso: yarn seed
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env.local' });

import mysql from 'mysql2/promise';

const FONTES = [
  { id: 1, slug: 'caixa',     nome: 'Caixa Econômica Federal', urlBase: 'https://venda-imoveis.caixa.gov.br' },
  { id: 2, slug: 'bb',        nome: 'Banco do Brasil',          urlBase: 'https://www8.bb.com.br/licitacaoimoveis' },
  { id: 3, slug: 'bradesco',  nome: 'Bradesco',                 urlBase: null },
  { id: 4, slug: 'santander', nome: 'Santander',                urlBase: 'https://www.santanderimoveis.com.br' },
  { id: 5, slug: 'itau',      nome: 'Itaú',                     urlBase: null },
  { id: 6, slug: 'sold',      nome: 'SOLD / Superbid',          urlBase: 'https://www.superbid.net' },
  { id: 7, slug: 'zuk',       nome: 'Portal ZUK',               urlBase: 'https://www.portalzuk.com.br' },
  { id: 8, slug: 'biasi',     nome: 'Biasi Leilões',            urlBase: null },
  { id: 9, slug: 'spy',       nome: 'Spy Leilões',              urlBase: 'https://www.spyleiloes.com.br' },
  { id: 10, slug: 'lj',       nome: 'Leilões Judiciais',        urlBase: 'https://www.leiloesjudiciais.com.br' },
  { id: 11, slug: 'inter',   nome: 'Banco Inter',               urlBase: 'https://imoveis.bancointer.com.br' },
];

async function main() {
  const pool = mysql.createPool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME     || 'leilaodb',
    user:     process.env.DB_USER     || 'leilao',
    password: process.env.DB_PASSWORD || '',
    waitForConnections: true,
    connectionLimit: 3,
  });

  console.log('Inserindo fontes...');

  for (const f of FONTES) {
    await pool.query(
      `INSERT INTO fonte (id, slug, nome, urlBase, ativa)
       VALUES (?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE slug=VALUES(slug), nome=VALUES(nome), urlBase=VALUES(urlBase)`,
      [f.id, f.slug, f.nome, f.urlBase]
    );
    console.log(`  ✓ [${f.id}] ${f.slug} — ${f.nome}`);
  }

  await pool.end();
  console.log('\nSeed concluído.');
}

main().catch(err => {
  console.error('Erro no seed:', err.message);
  process.exit(1);
});
