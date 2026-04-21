import { useEffect, useRef, useState } from 'react';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  type ActionAnnotations,
  type ActionContext,
  tesseron,
  type WelcomeResult,
  WebTesseronClient,
} from '@tesseron/web';

export * from '@tesseron/web';

export interface UseTesseronActionOptions<I, O> {
  description?: string;
  input?: StandardSchemaV1<I>;
  inputJsonSchema?: unknown;
  output?: StandardSchemaV1<O>;
  outputJsonSchema?: unknown;
  annotations?: ActionAnnotations;
  timeoutMs?: number;
  strictOutput?: boolean;
  handler: (input: I, ctx: ActionContext) => Promise<O> | O;
}

export function useTesseronAction<I = unknown, O = unknown>(
  name: string,
  options: UseTesseronActionOptions<I, O>,
  client: WebTesseronClient = tesseron,
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let builder = client.action<I, O>(name);
    const o = optionsRef.current;
    if (o.description) builder = builder.describe(o.description);
    if (o.input) builder = builder.input(o.input, o.inputJsonSchema);
    if (o.output) builder = builder.output(o.output, o.outputJsonSchema);
    if (o.annotations) builder = builder.annotate(o.annotations);
    if (o.timeoutMs) builder = builder.timeout(o.timeoutMs);
    if (o.strictOutput) builder = builder.strictOutput();
    builder.handler((input, ctx) => optionsRef.current.handler(input, ctx));
    return () => {
      client.removeAction(name);
    };
  }, [name, client]);
}

export interface UseTesseronResourceOptions<T> {
  description?: string;
  output?: StandardSchemaV1<T>;
  outputJsonSchema?: unknown;
  read?: () => T | Promise<T>;
  subscribe?: (emit: (value: T) => void) => () => void;
}

export function useTesseronResource<T = unknown>(
  name: string,
  optionsOrReader: UseTesseronResourceOptions<T> | (() => T | Promise<T>),
  client: WebTesseronClient = tesseron,
): void {
  const options: UseTesseronResourceOptions<T> =
    typeof optionsOrReader === 'function' ? { read: optionsOrReader } : optionsOrReader;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let builder = client.resource<T>(name);
    const o = optionsRef.current;
    if (o.description) builder = builder.describe(o.description);
    if (o.output) builder = builder.output(o.output, o.outputJsonSchema);
    if (o.read) builder = builder.read(() => optionsRef.current.read!());
    if (o.subscribe) {
      builder = builder.subscribe((emit) => optionsRef.current.subscribe!(emit));
    }
    return () => {
      client.removeResource(name);
    };
  }, [name, client]);
}

export interface UseTesseronConnectionOptions {
  url?: string;
  enabled?: boolean;
}

export interface TesseronConnectionState {
  status: 'idle' | 'connecting' | 'open' | 'error' | 'closed';
  welcome?: WelcomeResult;
  claimCode?: string;
  error?: Error;
}

export function useTesseronConnection(
  options: UseTesseronConnectionOptions = {},
  client: WebTesseronClient = tesseron,
): TesseronConnectionState {
  const [state, setState] = useState<TesseronConnectionState>({ status: 'idle' });
  const enabled = options.enabled ?? true;
  const url = options.url;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState({ status: 'connecting' });
    client
      .connect(url)
      .then((welcome) => {
        if (cancelled) return;
        setState({ status: 'open', welcome, claimCode: welcome.claimCode });
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setState({ status: 'error', error });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, url, client]);

  return state;
}
