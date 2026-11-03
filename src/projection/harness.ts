import type { ConfigValue, Platform } from "../domain/resource.ts";
import type { CanonicalModel, TargetId } from "./model.ts";

/**
 * The contract every harness adapter implements.
 *
 * An adapter is pure: it computes absolute paths from a RootContext and
 * content from the Canonical Model. The projection engine owns observation,
 * planning, takeover snapshots and every write, and refuses any content for
 * a surface the layout does not list.
 */

export type ConfigFormat = "json" | "toml" | "yaml";
export type SupportLevel = "native" | "portable" | "translated" | "shim" | "lossy" | "unsupported";
export type Feature = "instructions" | "rules" | "skills" | "mcp" | "hooks" | "agents" | "commands";

export interface HarnessDescriptor {
  readonly id: TargetId;
  readonly name: string;
  /** Executable names that mean the harness is installed (`detect.ts`). */
  readonly executables: ReadonlyArray<string>;
  /**
   * Executables whose names other tools share (Cursor's `agent`). One of these
   * counts only when the harness root exists too.
   */
  readonly genericExecutables?: ReadonlyArray<string> | undefined;
  /** Vendor documentation the layout was checked against. */
  readonly docs: ReadonlyArray<string>;
  /** Date (YYYY-MM-DD) the layout was last checked against `docs`. */
  readonly verifiedAt: string;
  readonly capabilities: Readonly<Record<Feature, SupportLevel>>;
  readonly notes?: ReadonlyArray<string> | undefined;
}

export interface Diagnostic {
  readonly level: "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly harness?: TargetId | undefined;
}

/** Where an adapter finds this machine's directories. */
export interface RootContext {
  readonly platform: Platform;
  /** Absolute home directory (`HOME`, or `USERPROFILE` on Windows). */
  readonly home: string;
  /** Windows `%APPDATA%`; on other platforms the same as the XDG config home. */
  readonly appData: string;
  /** An environment variable, or undefined when it is unset or empty. */
  readonly environment: (name: string) => string | undefined;
  /** Joins segments with this platform's separator. */
  readonly join: (...segments: ReadonlyArray<string>) => string;
}

/** Stable identifier of a surface within its harness, for example `skills`. */
export type SurfaceId = string;

/**
 * Something Canonfig owns inside a harness.
 *
 * - `file`: the whole file is replaced.
 * - `directory`: the whole directory is replaced; entries Canonfig never wrote
 *   are removed at takeover and reported as drift afterward.
 * - `config`: only `keys` (config key paths) are owned in a file the harness
 *   shares with its own state. `settings` marks the file that receives the
 *   harness's declared `settings.<harness>` keys; `reserved` lists keys a
 *   declaration may never name, such as credentials or provider keys.
 */
export type OwnedSurface =
  | { readonly id: SurfaceId; readonly kind: "file"; readonly target: string }
  | { readonly id: SurfaceId; readonly kind: "directory"; readonly target: string }
  | {
    readonly id: SurfaceId;
    readonly kind: "config";
    readonly target: string;
    /**
     * Other names the harness reads for the same file (`opencode.jsonc`).
     * The engine uses the first one that exists when `target` does not.
     */
    readonly alternatives?: ReadonlyArray<string> | undefined;
    readonly format: ConfigFormat;
    readonly keys: ReadonlyArray<string>;
    readonly settings?: { readonly reserved: ReadonlyArray<string> } | undefined;
  };

export interface HarnessLayout {
  /** The root pinned at takeover; it must resolve inside the home directory. */
  readonly root: string;
  readonly surfaces: ReadonlyArray<OwnedSurface>;
  /**
   * Absolute files and directories the harness keeps its own state in
   * (credentials, sessions, history). No surface target may equal or contain
   * one, and no snapshot ever reads one.
   */
  readonly neverTouch: ReadonlyArray<string>;
  /** Skills go to the shared `~/.agents/skills/` instead of a private surface. */
  readonly sharedSkills: boolean;
}

export interface ProjectedFile {
  /** Relative to the directory surface, forward slashes. */
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly executable?: boolean | undefined;
}

export type SurfaceContent =
  | {
    readonly kind: "file";
    readonly surface: SurfaceId;
    readonly content: string | Uint8Array;
    readonly executable?: boolean | undefined;
  }
  | {
    readonly kind: "directory";
    readonly surface: SurfaceId;
    readonly files: ReadonlyArray<ProjectedFile>;
  }
  | {
    readonly kind: "config";
    readonly surface: SurfaceId;
    readonly keys: ReadonlyArray<{ readonly path: string; readonly value: ConfigValue }>;
  };

/** Machine facts an adapter embeds in generated content. */
export interface ProjectionRuntime {
  /** Absolute path of the Canonical Folder. */
  readonly folder: string;
  /** Absolute path of the generated hook runner. */
  readonly hookRunner: string;
  readonly platform: Platform;
}

export interface HarnessProjection {
  readonly contents: ReadonlyArray<SurfaceContent>;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
}

export interface HarnessAdapter {
  readonly descriptor: HarnessDescriptor;
  readonly layout: (context: RootContext, model: CanonicalModel) => HarnessLayout;
  /**
   * Content for the surfaces that have something to hold. A surface without
   * content is left alone; declared settings are added by the engine.
   */
  readonly project: (
    model: CanonicalModel,
    layout: HarnessLayout,
    runtime: ProjectionRuntime,
  ) => HarnessProjection;
}
