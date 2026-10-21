import mysql from 'mysql2/promise';
import { ImovelRaw } from '../scrapers/types';
import { geocodificar } from './geocodificar';

let pool: mysql.Pool | null = null;

function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host:     process.env.DB_HOST     || 'localhost',
      port:     Number(process.env.DB_PORT || 3306),
      database: process.env.DB_NAME     || 'leilaodb',
      user:     process.env.DB_USER     || 'leilao',
      password: process.env.DB_PASSWORD || '',
      waitForConnections: true,
      connectionLimit: 5,
    });
  }
  return pool;
}

const FONTE_IDS: Record<string, number> = {
  caixa:     1,
  bb:        2,
  bradesco:  3,
  santander: 4,
  itau:      5,
  sold:      6,
  zuk:       7,
  biasi:     8,
  spy:       9,
  lj:        10,
  inter:     11,
};

function calcularScore(imovel: ImovelRaw): number {
  let score = 0;
  const desconto = imovel.valorAvaliacao > 0
    ? ((imovel.valorAvaliacao - imovel.valorMinimo) / imovel.valorAvaliacao) * 100
    : 0;
  score += Math.min(50, desconto);
  if (imovel.ocupado === 'nao') score += 20;
  if (imovel.modalidade === 'segundo_leilao') score += 10;
  if (imovel.imagens.length > 0) score += 5;
  if (imovel.dataLeilao) score += 5;
  if (imovel.areaTotal) score += 5;
  if (imovel.tipo === 'apartamento' || imovel.tipo === 'casa') score += 5;
  return Math.min(100, Math.round(score));
}

export async function processarImoveis(fonteSlug: string, imoveis: ImovelRaw[]) {
  const fonteId = FONTE_IDS[fonteSlug];
  if (!fonteId) throw new Error(`Fonte desconhecida: ${fonteSlug}`);

  const db = getPool();
  let novos = 0;
  let atualizados = 0;

  for (const raw of imoveis) {
    const descontoBruto = raw.valorAvaliacao > 0
      ? ((raw.valorAvaliacao - raw.valorMinimo) / raw.valorAvaliacao) * 100
      : 0;
    // Coluna é decimal(5,2): limita a ±999.99 (dados inconsistentes da fonte)
    const desconto = Math.max(-999.99, Math.min(999.99, descontoBruto));
    const score = calcularScore(raw);

    try {
      const [rows] = await db.query<mysql.RowDataPacket[]>(
        'SELECT id FROM imovel WHERE fonteId = ? AND codigoFonte = ? LIMIT 1',
        [fonteId, raw.codigoFonte]
      );

      if (rows.length > 0) {
        const imovelId = rows[0].id;
        await db.query(
          `UPDATE imovel SET
            urlFonte=?, tipo=?, modalidade=?, estado=?, cidade=?, bairro=?,
            endereco=?, cep=?, valorAvaliacao=?, valorMinimo=?, descontoPercent=?,
            areaTotal=?, areaConstruida=?, quartos=?, vagas=?, ocupado=?,
            dataLeilao=?, score=?, ativo=1
          WHERE id=?`,
          [
            raw.urlFonte, raw.tipo, raw.modalidade,
            raw.estado.toUpperCase().substring(0, 2), raw.cidade,
            raw.bairro || null, raw.endereco || null, raw.cep || null,
            raw.valorAvaliacao.toFixed(2), raw.valorMinimo.toFixed(2), desconto.toFixed(2),
            raw.areaTotal?.toFixed(2) || null, raw.areaConstruida?.toFixed(2) || null,
            raw.quartos || null, raw.vagas || null,
            raw.ocupado || 'desconhecido', raw.dataLeilao || null,
            score, imovelId,
          ]
        );

        if (raw.imagens.length > 0) {
          await db.query('DELETE FROM imagem WHERE imovelId = ?', [imovelId]);
          for (let i = 0; i < raw.imagens.length; i++) {
            await db.query(
              'INSERT INTO imagem (imovelId, urlOriginal, ordem) VALUES (?, ?, ?)',
              [imovelId, raw.imagens[i], i]
            );
          }
        }
        atualizados++;
      } else {
        const [result] = await db.query<mysql.ResultSetHeader>(
          `INSERT INTO imovel
            (fonteId, codigoFonte, urlFonte, tipo, modalidade, estado, cidade,
             bairro, endereco, cep, valorAvaliacao, valorMinimo, descontoPercent,
             areaTotal, areaConstruida, quartos, vagas, ocupado, dataLeilao, score, ativo)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
          [
            fonteId, raw.codigoFonte, raw.urlFonte, raw.tipo, raw.modalidade,
            raw.estado.toUpperCase().substring(0, 2), raw.cidade,
            raw.bairro || null, raw.endereco || null, raw.cep || null,
            raw.valorAvaliacao.toFixed(2), raw.valorMinimo.toFixed(2), desconto.toFixed(2),
            raw.areaTotal?.toFixed(2) || null, raw.areaConstruida?.toFixed(2) || null,
            raw.quartos || null, raw.vagas || null,
            raw.ocupado || 'desconhecido', raw.dataLeilao || null, score,
          ]
        );

        const imovelId = result.insertId;
        for (let i = 0; i < raw.imagens.length; i++) {
          await db.query(
            'INSERT INTO imagem (imovelId, urlOriginal, ordem) VALUES (?, ?, ?)',
            [imovelId, raw.imagens[i], i]
          );
        }

        // Usar lat/lng fornecidos pelo scraper (ex.: ZUK), ou geocodificar via Nominatim
        if (raw.latitude != null && raw.longitude != null) {
          await db.query(
            'UPDATE imovel SET latitude = ?, longitude = ? WHERE id = ?',
            [raw.latitude, raw.longitude, imovelId]
          );
        } else {
          const coords = await geocodificar(raw.endereco, raw.bairro, raw.cidade, raw.estado);
          if (coords) {
            await db.query(
              'UPDATE imovel SET latitude = ?, longitude = ? WHERE id = ?',
              [coords.latitude, coords.longitude, imovelId]
            );
          }
        }

        novos++;
      }
    } catch (err: any) {
      console.error(`[Worker] Erro ao processar ${raw.codigoFonte}:`, err.message);
    }
  }

  // Desativar imóveis da fonte que não apareceram nesta rodada
  if (imoveis.length > 0) {
    const codigosAtivos = imoveis.map(i => i.codigoFonte);
    const placeholders = codigosAtivos.map(() => '?').join(',');
    const [result] = await db.query<mysql.ResultSetHeader>(
      `UPDATE imovel SET ativo=0
       WHERE fonteId=? AND ativo=1 AND codigoFonte NOT IN (${placeholders})`,
      [fonteId, ...codigosAtivos]
    );
    const desativados = result.affectedRows;
    if (desativados > 0) {
      console.log(`[Worker] ${fonteSlug}: ${desativados} encerrados (não encontrados nesta rodada)`);
    }
  }

  console.log(`[Worker] ${fonteSlug}: ${novos} novos, ${atualizados} atualizados`);
  return { novos, atualizados };
}

// Encerrar imóveis cujo leilão (última praça) já passou — vale para todas as fontes,
// inclusive as que falharam nesta rodada ou que continuam listando leilões vencidos
export async function encerrarVencidos(): Promise<number> {
  const db = getPool();
  const [result] = await db.query<mysql.ResultSetHeader>(
    `UPDATE imovel SET ativo=0
     WHERE ativo=1 AND COALESCE(dataLeilao2, dataLeilao) < NOW()`
  );
  const encerrados = result.affectedRows;
  console.log(`[Worker] ${encerrados} imóveis encerrados por data de leilão vencida`);
  return encerrados;
}
