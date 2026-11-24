export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const bad = (message, code = 'bad_request', extra) =>
  new ApiError(400, code, message, extra);

export const notFound = (message = 'Não encontrado.') =>
  new ApiError(404, 'not_found', message);

export const conflict = (message, code = 'conflict', extra) =>
  new ApiError(409, code, message, extra);

export const forbidden = (message = 'Acesso negado.') =>
  new ApiError(403, 'forbidden', message);
