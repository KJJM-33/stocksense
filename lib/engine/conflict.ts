/**
 * StockSense Intelligence Engine — Conflict Resolver
 *
 * When two inputs contradict each other, this module applies precedence rules
 * and logs the conflict. Conflicts are NEVER silently discarded — both inputs
 * are always preserved for audit.
 *
 * Precedence rules (highest to lowest):
 * 1. Manual correction (source: 'manual') — user ground truth always wins
 * 2. Photo reconciliation (source: 'photo') — physical evidence beats taps
 * 3. Receipt scan (source: 'receipt') — structured data beats NL/WhatsApp
 * 4. WhatsApp / SMS (source: 'whatsapp' | 'sms')
 * 5. NFC tap (source: 'tap')
 * 6. System inferred (source: 'system') — lowest precedence
 * When same source type: more recent timestamp wins.
 */

import type { Conflict, ConflictType, InputSource, EngineInput } from './types';
import { randomUUID } from 'crypto';

/** Source precedence — higher number = higher authority */
const SOURCE_PRECEDENCE: Record<InputSource, number> = {
  manual: 5,
  photo: 4,
  receipt: 3,
  whatsapp: 2,
  tap: 1,
  system: 0,
};

export interface ConflictInput {
  source: InputSource;
  timestamp: Date;
  /** Serialisable representation of the input */
  payload: Record<string, unknown>;
}

export class ConflictResolver {
  private conflicts: Map<string, Conflict> = new Map();

  /**
   * Resolves a conflict between two contradicting inputs.
   * Applies precedence rules and logs both inputs.
   * Never silently discards either input.
   *
   * Rule order:
   * 1. Manual correction always wins
   * 2. Photo/fridge scan beats tap input
   * 3. Receipt scan beats WhatsApp text
   * 4. More recent timestamp wins when same source type
   *
   * @param input1 - First (earlier or lower-precedence) input
   * @param input2 - Second (later or higher-precedence) input
   * @param itemId - The item both inputs relate to
   * @param conflictType - Category of conflict
   * @returns Conflict record with resolution applied
   */
  resolve(
    input1: ConflictInput,
    input2: ConflictInput,
    itemId: string,
    conflictType: ConflictType
  ): Conflict {
    const winner = this.determineWinner(input1, input2);

    const conflict: Conflict = {
      id: randomUUID(),
      itemId,
      conflictType,
      input1: input1.payload,
      input2: input2.payload,
      resolution: winner,
      resolvedAt: new Date(),
      resolvedBy: 'system',
      createdAt: new Date(),
    };

    this.conflicts.set(conflict.id, conflict);
    return conflict;
  }

  /**
   * Returns a list of all open (unresolved) conflicts.
   * These are conflicts that require manual user resolution.
   *
   * @returns Array of Conflict records with resolution='pending'
   */
  getUnresolved(): Conflict[] {
    return Array.from(this.conflicts.values()).filter(
      (c) => c.resolution === 'pending'
    );
  }

  /**
   * Returns all conflicts for a specific item.
   *
   * @param itemId - The item to query
   * @returns Array of Conflict records for this item
   */
  getByItem(itemId: string): Conflict[] {
    return Array.from(this.conflicts.values()).filter((c) => c.itemId === itemId);
  }

  /**
   * Marks a conflict as manually resolved by the user.
   *
   * @param conflictId - The conflict to resolve
   * @param resolution - Which input the user chose ('input1' or 'input2')
   * @returns The updated Conflict record, or null if not found
   */
  manualResolve(
    conflictId: string,
    resolution: 'input1' | 'input2'
  ): Conflict | null {
    const conflict = this.conflicts.get(conflictId);
    if (!conflict) return null;

    const updated: Conflict = {
      ...conflict,
      resolution,
      resolvedAt: new Date(),
      resolvedBy: 'user',
    };
    this.conflicts.set(conflictId, updated);
    return updated;
  }

  /**
   * Creates a pending conflict (requiring manual resolution).
   * Used for name-matching ambiguities that the system cannot auto-resolve.
   *
   * @param itemId - The item involved
   * @param conflictType - Category of conflict
   * @param input1 - First input payload
   * @param input2 - Second input payload
   * @returns Conflict record with resolution='pending'
   */
  createPending(
    itemId: string,
    conflictType: ConflictType,
    input1: Record<string, unknown>,
    input2: Record<string, unknown>
  ): Conflict {
    const conflict: Conflict = {
      id: randomUUID(),
      itemId,
      conflictType,
      input1,
      input2,
      resolution: 'pending',
      resolvedAt: null,
      resolvedBy: null,
      createdAt: new Date(),
    };
    this.conflicts.set(conflict.id, conflict);
    return conflict;
  }

  /**
   * Checks whether two inputs conflict (contradict each other).
   * Two 'low' taps on the same item do NOT conflict.
   * A 'low' tap and an 'out' tap DO conflict.
   *
   * @param a - First input
   * @param b - Second input
   * @returns true if the inputs contradict
   */
  doConflict(a: ConflictInput, b: ConflictInput): boolean {
    // If the payloads agree on status/quantity, no conflict
    if (a.payload['status'] !== undefined && b.payload['status'] !== undefined) {
      return a.payload['status'] !== b.payload['status'];
    }
    if (a.payload['quantity'] !== undefined && b.payload['quantity'] !== undefined) {
      // Small numeric differences are noise, not conflicts
      const diff = Math.abs(Number(a.payload['quantity']) - Number(b.payload['quantity']));
      return diff > 0.01;
    }
    // Different sources saying different things = likely conflict
    return true;
  }

  /**
   * Returns all conflicts (for persistence / audit log).
   * @returns Array of all Conflict records
   */
  getAll(): Conflict[] {
    return Array.from(this.conflicts.values());
  }

  /**
   * Loads conflicts from persistent storage (repository layer).
   * @param conflicts - Array of Conflict records to load
   */
  load(conflicts: Conflict[]): void {
    for (const c of conflicts) {
      this.conflicts.set(c.id, c);
    }
  }

  private determineWinner(
    input1: ConflictInput,
    input2: ConflictInput
  ): 'input1' | 'input2' {
    const p1 = SOURCE_PRECEDENCE[input1.source] ?? 0;
    const p2 = SOURCE_PRECEDENCE[input2.source] ?? 0;

    if (p1 !== p2) {
      // Higher precedence wins
      return p1 > p2 ? 'input1' : 'input2';
    }

    // Same source type: more recent wins
    return input2.timestamp > input1.timestamp ? 'input2' : 'input1';
  }
}
