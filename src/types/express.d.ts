import 'express';

declare module 'express' {
  interface Request {
    signal?: AbortSignal | undefined;
  }
}
