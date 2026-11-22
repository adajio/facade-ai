export class IntakeError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function notFound(): never {
  throw new IntakeError(404, "intake_not_found", "Intake object not found");
}

export function conflict(code: string, message: string): never {
  throw new IntakeError(409, code, message);
}

export function invalid(code: string, message: string): never {
  throw new IntakeError(422, code, message);
}
