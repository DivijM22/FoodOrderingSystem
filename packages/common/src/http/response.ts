import type { Response } from 'express';

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** Consistent success envelope: { success: true, data, meta? } */
export function sendSuccess<T>(res: Response, data: T, status = 200, meta?: PageMeta): Response {
  return res.status(status).json(meta ? { success: true, data, meta } : { success: true, data });
}

export function pageMeta(page: number, limit: number, total: number): PageMeta {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}
