import axios from 'axios';
import mysql from 'mysql2/promise';

const http = axios.create({
  timeout: 8000,
  headers: {
    'User-Agent': 'LeilaoPro/1.0 (scraper educacional)',
    'Accept-Language': 'pt-BR,pt',
  },
});

let lastCall = 0;

async function rateLimit() {
  const now = Date.now();
  const wait = 1100 - (now - lastCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
}

export interface Coords {
  latitude: number;
  longitude: number;
}

export async function geocodificar(
  endereco?: string | null,
  bairro?: string | null,
  cidade?: string | null,
  estado?: string | null
): Promise<Coords | null> {
  // Tenta do mais específico para o menos específico
  const queries = [
    [endereco, bairro, cidade, estado, 'Brasil'].filter(Boolean).join(', '),
    [bairro, cidade, estado, 'Brasil'].filter(Boolean).join(', '),
    [cidade, estado, 'Brasil'].filter(Boolean).join(', '),
  ];

  for (const q of queries) {
    if (!q || q.trim() === 'Brasil') continue;
    try {
      await rateLimit();
      const resp = await http.get('https://nominatim.openstreetmap.org/search', {
        params: { q, format: 'json', limit: 1, countrycodes: 'br' },
      });
      if (resp.data.length > 0) {
        return {
          latitude: parseFloat(resp.data[0].lat),
          longitude: parseFloat(resp.data[0].lon),
        };
      }
    } catch {
      // tenta query menos específica
    }
  }
  return null;
}

// Job para geocodificar imóveis sem coordenadas no banco
export async function geocodificarImovelSemCoordenadas(pool: mysql.Pool, limite = 50) {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT id, endereco, bairro, cidade, estado
     FROM imovel
     WHERE latitude IS NULL AND ativo = 1
     ORDER BY score DESC
     LIMIT ?`,
    [limite]
  );

  if (rows.length === 0) {
    console.log('[Geo] Nenhum imóvel sem coordenadas.');
    return;
  }

  console.log(`[Geo] Geocodificando ${rows.length} imóveis...`);
  let ok = 0;
  let falhou = 0;

  for (const row of rows) {
    const coords = await geocodificar(row.endereco, row.bairro, row.cidade, row.estado);
    if (coords) {
      await pool.query(
        'UPDATE imovel SET latitude = ?, longitude = ? WHERE id = ?',
        [coords.latitude, coords.longitude, row.id]
      );
      ok++;
    } else {
      falhou++;
    }
  }

  console.log(`[Geo] ${ok} geocodificados, ${falhou} sem resultado.`);
}
