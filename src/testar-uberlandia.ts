import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env.local' });

import { scraperCaixa } from './scrapers/caixa';
import { processarImoveis } from './jobs/processarImoveis';

(async () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Teste — Caixa MG / Uberlândia');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const result = await scraperCaixa({ MG: ['UBERLANDIA'] });

  console.log(`\n━━━ Scraping concluído ━━━`);
  console.log(`Imóveis coletados: ${result.imoveis.length}`);
  console.log(`Erros: ${result.erros.length}`);

  if (result.erros.length > 0) {
    console.log('\nErros encontrados:');
    result.erros.forEach(e => console.log(' -', e));
  }

  if (result.imoveis.length > 0) {
    console.log('\nSalvando no banco...');
    const stats = await processarImoveis('caixa', result.imoveis);
    console.log(`✓ ${stats.novos} novos | ${stats.atualizados} atualizados`);
    console.log('\nPrimeiros 3 imóveis:');
    result.imoveis.slice(0, 3).forEach(im => {
      console.log(`  - ${im.tipo} | ${im.bairro} | av: R$${im.valorAvaliacao.toLocaleString('pt-BR')} | mín: R$${im.valorMinimo.toLocaleString('pt-BR')} | ${im.modalidade}`);
    });
  } else {
    console.log('\nNenhum imóvel encontrado — verifique se o site está acessível.');
  }

  process.exit(0);
})();
