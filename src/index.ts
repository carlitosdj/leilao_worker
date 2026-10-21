import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env.local' });

import cron from 'node-cron';
import { iniciarAtualizacao, iniciarServidor } from './servidor';

// Servidor interno: permite disparar e acompanhar a atualização pelo app (/admin)
iniciarServidor();

// Todas as execuções (inicial, cron e manual) passam por iniciarAtualizacao,
// que roda o atualiza.ts e impede duas atualizações ao mesmo tempo
function agendar(origem: string) {
  if (!iniciarAtualizacao(origem)) {
    console.log(`[Worker] Atualização (${origem}) ignorada: já existe uma em andamento`);
  }
}

// Rodar ao iniciar
agendar('inicio');

// Agendar: todo dia às 6h e 18h
cron.schedule('0 6,18 * * *', () => {
  agendar('cron');
});

console.log('[Worker] Agendador iniciado. Próximas execuções: 06:00 e 18:00 diariamente.');
