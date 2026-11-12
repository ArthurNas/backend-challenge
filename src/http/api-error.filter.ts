import { ArgumentsHost, Catch, Logger, ExceptionFilter, HttpException } from '@nestjs/common';
import { ApplicationError } from '../application/application-error';
import { DomainError } from '../domain/domain-error';
import { randomUUID } from 'node:crypto';
import {
  databaseErrorCode,
  isTransientDatabaseError,
} from '../infrastructure/database/database-errors';

interface ResponseWriter {
  status(code: number): ResponseWriter;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

interface ErrorRequest {
  headers: Record<string, unknown>;
  body?: unknown;
}

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiError');

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<ResponseWriter>();
    const request = host.switchToHttp().getRequest<ErrorRequest>();
    const correlationId = this.identifier(request.headers['x-correlation-id']) ?? randomUUID();

    response.setHeader('X-Correlation-Id', correlationId);

    const mapped = this.map(error);
    if (mapped.statusCode >= 500) {
      const body = this.bodyIdentifiers(request.body);

      this.logger.error({
        code: mapped.code,
        correlationId,
        messageId: null,
        transactionId: null,
        walletId: body.walletId,
        providerId: body.providerId,
      });
    }

    response.status(mapped.statusCode).json(mapped);
  }

  private identifier(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 255 || value.length === 0) return null;

    return value;
  }

  private bodyIdentifiers(body: unknown): { walletId: string | null; providerId: string | null } {
    if (typeof body !== 'object' || body === null) return { walletId: null, providerId: null };

    const fields = body as Record<string, unknown>;

    return {
      walletId: this.identifier(fields.walletId),
      providerId: this.identifier(fields.providerId),
    };
  }

  private map(error: unknown): { code: string; statusCode: number } {
    if (error instanceof ApplicationError) {
      return { code: error.code, statusCode: error.statusCode };
    }

    if (error instanceof DomainError && error.code === 'IDEMPOTENCY_CONFLICT') {
      return { code: error.code, statusCode: 409 };
    }

    if (error instanceof DomainError && error.code === 'INVALID_TRANSACTION_STATE') {
      return { code: 'INTERNAL_ERROR', statusCode: 500 };
    }

    if (error instanceof DomainError) return { code: error.code, statusCode: 400 };

    if (databaseErrorCode(error) === '23505') return { code: 'RESOURCE_CONFLICT', statusCode: 409 };

    if (isTransientDatabaseError(error)) {
      return { code: 'INFRASTRUCTURE_UNAVAILABLE', statusCode: 503 };
    }

    if (error instanceof HttpException) {
      return { code: 'HTTP_ERROR', statusCode: error.getStatus() };
    }

    return { code: 'INTERNAL_ERROR', statusCode: 500 };
  }
}
