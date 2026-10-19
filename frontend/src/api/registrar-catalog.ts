// SPDX-License-Identifier: AGPL-3.0-only
import { api } from './client.js';

export interface RegistrarPrice {
  registrar: string;
  register: number;
  renew: number;
  transfer: number;
  currency: 'EUR';
}

export interface TldMatrix {
  tld: string;
  prices: RegistrarPrice[];
  cheapestRegistrar: string;
  cheapestPrice: number;
}

export interface Registrar {
  name: string;
  tlds: string[];
  note: string;
}

export interface TcoResult {
  domain: string;
  tld: string;
  holdingYears: number;
  registrar: string;
  totalCostEur: number;
  breakdown: Array<{ year: number; costEur: number; label: string }>;
}

export interface Recommendation {
  domain: string;
  tld: string;
  holdingYears: number;
  recommendedRegistrar: string;
  cheapestRegistrar: string;
  savingsEur: number;
  rationale: string;
}

export function getTlds(): Promise<{ tlds: string[] }> {
  return api.get<{ tlds: string[] }>('/registrar/tlds');
}

export function getRegistrars(): Promise<{ registrars: Registrar[] }> {
  return api.get<{ registrars: Registrar[] }>('/registrar/registrars');
}

export function getTldMatrix(tld: string): Promise<{ matrix: TldMatrix }> {
  return api.get<{ matrix: TldMatrix }>(`/registrar/tlds/${tld}`);
}

export function computeTco(domain: string, holdingYears: number): Promise<{ tco: TcoResult }> {
  const params = new URLSearchParams();
  params.set('domain', domain);
  params.set('holdingYears', String(holdingYears));
  return api.get<{ tco: TcoResult }>(`/registrar/tco?${params.toString()}`);
}

export function recommendRegistrar(
  domain: string,
  holdingYears: number,
): Promise<{ recommendation: Recommendation }> {
  const params = new URLSearchParams();
  params.set('domain', domain);
  params.set('holdingYears', String(holdingYears));
  return api.get<{ recommendation: Recommendation }>(`/registrar/recommend?${params.toString()}`);
}
