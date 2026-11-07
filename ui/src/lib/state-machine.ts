import { useCallback, useRef, useState } from "react";

export class TransitionError extends Error {
  readonly _tag = "TransitionError";
  readonly machine: string; readonly state: string; readonly event: string;
  constructor(machine: string, state: string, event: string) {
    super(`${machine} cannot ${event} while ${state}.`);
    this.machine = machine; this.state = state; this.event = event;
  }
}

/** Advance the owner before React batches a render, so rapid commands cannot share an old state. */
export function useStateMachine<State, Event>(initial: State, transition: (state: State, event: Event) => State) {
  const [state, setState] = useState(initial);
  const current = useRef(state);
  const send = useCallback((event: Event) => {
    const next = transition(current.current, event);
    current.current = next; setState(next);
    return next;
  }, [transition]);
  return { state, current, send };
}
