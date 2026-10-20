// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import {
  getTlds,
  getRegistrars,
  getTldMatrix,
  computeTco,
  recommendRegistrar,
  type TldMatrix,
  type Registrar,
  type TcoResult,
  type Recommendation,
} from '@/api/registrar-catalog';

export function useRegistrarCatalog() {
  const [selectedTld, setSelectedTld] = useState<string>('');
  const [tldsData, setTldsData] = useState<string[]>([]);
  const [registrarsData, setRegistrarsData] = useState<Registrar[]>([]);
  const [matrixData, setMatrixData] = useState<TldMatrix | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const loadTlds = async () => {
    const { tlds } = await getTlds();
    setTldsData(tlds);
    return tlds;
  };

  const loadRegistrars = async () => {
    const { registrars } = await getRegistrars();
    setRegistrarsData(registrars);
    return registrars;
  };

  const loadMatrix = async (tld: string) => {
    setIsLoading(true);
    try {
      const { matrix } = await getTldMatrix(tld);
      setMatrixData(matrix);
      setSelectedTld(tld);
      return matrix;
    } finally {
      setIsLoading(false);
    }
  };

  const computeTcoFor = async (domain: string, holdingYears: number): Promise<TcoResult | null> => {
    try {
      const { tco } = await computeTco(domain, holdingYears);
      return tco;
    } catch (_err) {
      return null;
    }
  };

  const recommendFor = async (
    domain: string,
    holdingYears: number,
  ): Promise<Recommendation | null> => {
    try {
      const { recommendation } = await recommendRegistrar(domain, holdingYears);
      return recommendation;
    } catch (_err) {
      return null;
    }
  };

  return {
    tlds: tldsData,
    registrars: registrarsData,
    selectedTld,
    matrix: matrixData,
    isLoading,
    loadTlds,
    loadRegistrars,
    loadMatrix,
    computeTcoFor,
    recommendFor,
  };
}

export function useTco() {
  const [result, setResult] = useState<TcoResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const compute = async (domain: string, holdingYears: number): Promise<TcoResult | null> => {
    setIsLoading(true);
    try {
      const { tco } = await computeTco(domain, holdingYears);
      setResult(tco);
      return tco;
    } finally {
      setIsLoading(false);
    }
  };

  return { result, isLoading, compute };
}

export function useRegistrarRecommendation() {
  const [result, setResult] = useState<Recommendation | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const recommend = async (
    domain: string,
    holdingYears: number,
  ): Promise<Recommendation | null> => {
    setIsLoading(true);
    try {
      const { recommendation } = await recommendRegistrar(domain, holdingYears);
      setResult(recommendation);
      return recommendation;
    } finally {
      setIsLoading(false);
    }
  };

  return { result, isLoading, recommend };
}

export const registrarCatalogQueryKeys = {
  all: ['registrar-catalog'] as const,
  tlds: () => [...registrarCatalogQueryKeys.all, 'tlds'] as const,
  registrars: () => [...registrarCatalogQueryKeys.all, 'registrars'] as const,
  matrix: (tld: string) => [...registrarCatalogQueryKeys.all, 'matrix', tld] as const,
};
