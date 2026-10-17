import { PaymentStatus, PublicPaymentOutcome } from './enums.js';

export const VALID_TRANSITIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [PaymentStatus.INITIATED]: [
    PaymentStatus.ACTIVE,
    PaymentStatus.QUEUED,
    PaymentStatus.CANCELLED,
    PaymentStatus.EXPIRED
  ],
  [PaymentStatus.QUEUED]: [
    PaymentStatus.ACTIVE,
    PaymentStatus.CANCELLED,
    PaymentStatus.EXPIRED
  ],
  [PaymentStatus.ACTIVE]: [
    PaymentStatus.PROCESSING,
    PaymentStatus.SUCCESS,
    PaymentStatus.FAILED,
    PaymentStatus.EXPIRED,
    PaymentStatus.CANCELLED
  ],
  [PaymentStatus.PROCESSING]: [
    PaymentStatus.SUCCESS,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELLED,
    PaymentStatus.EXPIRED
  ],
  [PaymentStatus.SUCCESS]: [],
  [PaymentStatus.FAILED]: [],
  [PaymentStatus.EXPIRED]: [],
  [PaymentStatus.CANCELLED]: []
});

export function isValidTransition(currentState: string, nextState: string): boolean {
  const allowed = VALID_TRANSITIONS[currentState];
  if (!allowed) return false;
  return allowed.includes(nextState);
}

export function assertValidTransition(currentState: string, nextState: string): void {
  if (!isValidTransition(currentState, nextState)) {
    throw new Error(
      `Illegal payment state transition: Cannot move from '${currentState}' to '${nextState}'.`
    );
  }
}

export function isTerminalStatus(status: string): boolean {
  return [
    PaymentStatus.SUCCESS,
    PaymentStatus.FAILED,
    PaymentStatus.EXPIRED,
    PaymentStatus.CANCELLED
  ].includes(status as any);
}

export function toPublicOutcome(status: string): string {
  switch (status) {
    case PaymentStatus.SUCCESS:
      return PublicPaymentOutcome.SUCCESS;
    case PaymentStatus.FAILED:
      return PublicPaymentOutcome.FAILED;
    case PaymentStatus.EXPIRED:
      return PublicPaymentOutcome.EXPIRED;
    case PaymentStatus.CANCELLED:
      return PublicPaymentOutcome.CANCELLED;
    default:
      throw new Error(`Status '${status}' is an internal non-terminal state and cannot be mapped to a public outcome.`);
  }
}
