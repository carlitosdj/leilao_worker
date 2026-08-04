export interface ImovelRaw {
  codigoFonte: string;
  urlFonte: string;
  tipo: 'apartamento' | 'casa' | 'terreno' | 'comercial' | 'rural' | 'outro';
  modalidade: 'primeiro_leilao' | 'segundo_leilao' | 'venda_direta' | 'licitacao';
  estado: string;
  cidade: string;
  bairro?: string;
  endereco?: string;
  cep?: string;
  valorAvaliacao: number;
  valorMinimo: number;
  areaTotal?: number;
  areaConstruida?: number;
  quartos?: number;
  vagas?: number;
  ocupado?: 'sim' | 'nao' | 'desconhecido';
  dataLeilao?: Date;
  dataLeilao2?: Date;
  imagens: string[];
  latitude?: number;
  longitude?: number;
  extras?: Record<string, any>;
}

export interface ScraperResult {
  imoveis: ImovelRaw[];
  erros: string[];
}
