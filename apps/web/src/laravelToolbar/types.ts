// The parts of the Laravel Toolbar payload (nckrtl/laravel-toolbar, ToolbarData) the bar
// reads. The page sends it as `window.__LARAVEL_TOOLBAR_DATA__`, in `x-toolbar` response
// headers and from `/_toolbar/requests/{id}`. Every field is optional: older package
// versions and disabled collectors leave parts out.

export interface Measurement {
  readonly formattedValue?: string;
  readonly value?: number;
  readonly unit?: string;
}

export interface SourceLocation {
  readonly file: string;
  readonly line: number;
}

export interface InertiaPropMeta {
  readonly shared?: boolean;
  /** always, defer, optional, merge, scroll or once. */
  readonly type?: string | null;
  readonly defer_group?: string | null;
  /** False for deferred props the first response leaves out. */
  readonly loaded?: boolean;
  readonly source?: SourceLocation | null;
}

export interface ToolbarStage {
  readonly label: string;
  readonly color?: string;
  readonly wall_time?: { readonly percentage?: number; readonly measurement?: Measurement };
  readonly memory_real_delta?: { readonly percentage?: number; readonly measurement?: Measurement };
}

export interface ToolbarQuery {
  readonly sql: string;
  readonly bindings?: readonly unknown[];
  readonly duration: number;
  readonly is_duplicate?: boolean;
  readonly is_slow?: boolean;
  readonly percentage?: number;
  readonly offset?: number;
  readonly file?: string | null;
  readonly line?: number | null;
  readonly editor_url?: string | null;
}

export interface ToolbarCookie {
  readonly name: string;
  readonly value?: string;
  readonly path?: string;
  readonly domain?: string;
  readonly same_site?: string | null;
  readonly secure?: boolean;
  readonly http_only?: boolean;
  readonly expires?: string | number | null;
}

export interface ToolbarMiddleware {
  readonly class: string;
  readonly editor_url?: string | null;
}

export interface ToolbarHistoryRow {
  readonly id: string;
  readonly is_xhr?: boolean;
  readonly method: string;
  readonly uri: string;
  readonly name?: string | null;
  readonly action?: string | null;
  readonly status_code?: number | null;
  readonly size?: string | null;
  readonly duration?: string | null;
  readonly response_type?: string | null;
  /** `redirect`: the next hop of a redirect; `partial`: a partial reload (deferred props). */
  readonly follow_up?: "redirect" | "partial" | null;
}

export interface ToolbarModel {
  readonly model?: string;
  readonly retrieved?: number;
  readonly created?: number;
  readonly updated?: number;
  readonly deleted?: number;
}

/** laravel-toolbar's per-class models entry; php-data-bridge sends `ToolbarModel` rows. */
export interface ToolbarModelEntry {
  readonly model?: string;
  readonly action?: string;
  readonly count?: number;
}

export interface ToolbarDependency {
  readonly id?: string;
  readonly name: string;
  readonly version?: string | null;
  readonly constraint?: string | null;
  readonly development?: boolean;
}

export interface ToolbarData {
  readonly request_id?: string;
  readonly selected_request_id?: string;
  readonly history_row?: ToolbarHistoryRow;
  readonly request_history?: readonly ToolbarHistoryRow[];
  readonly profiler?: {
    readonly total_wall_time?: Measurement;
    readonly total_real_memory?: Measurement;
    readonly total_allocated_memory?: Measurement;
    readonly stages?: readonly ToolbarStage[];
  };
  readonly request?: {
    readonly route_name?: string | null;
    readonly route_uri?: string | null;
    readonly method?: string;
    readonly uri?: string;
    readonly ip_address?: string | null;
    readonly controller_action?: string | null;
    readonly route_editor_url?: string | null;
    readonly middleware?: readonly ToolbarMiddleware[];
    readonly is_inertia?: boolean;
    readonly headers?: Readonly<Record<string, readonly string[]>>;
    readonly view_name?: string | null;
    readonly view_data?: Readonly<Record<string, unknown>> | string | null;
  };
  readonly response?: {
    readonly status_code?: number;
    readonly headers?: Readonly<Record<string, readonly string[]>>;
    readonly size?: Measurement | string | null;
    readonly content_type?: string | null;
    readonly redirect_to?: string | null;
    readonly cookies?: readonly ToolbarCookie[];
  };
  readonly queries?: {
    readonly totalTime?: number;
    readonly databases?: readonly {
      readonly name?: string;
      readonly driver?: string;
      readonly tablePlusConnectionUrl?: string | null;
    }[];
    readonly queries?: readonly ToolbarQuery[];
  };
  readonly models?: readonly ToolbarModel[] | Readonly<Record<string, ToolbarModelEntry>> | null;
  readonly laravel?: {
    readonly version?: string;
    readonly environment?: string;
    readonly timezone?: string;
    readonly locale?: string;
    readonly debug?: string | boolean;
    readonly host?: string;
  };
  /** php-data-bridge for apps without the package, such as Symfony. */
  readonly framework?: {
    readonly name?: string;
    readonly version?: string | null;
    readonly environment?: string | null;
    readonly debug?: string | boolean | null;
    readonly host?: string | null;
  };
  readonly php?: {
    readonly version?: string;
    readonly memory_limit?: string;
    readonly max_execution_time?: string | number;
    /** Package 0.3.8+: the details below. */
    readonly sapi?: string | null;
    readonly settings?: Readonly<Record<string, string | null>> | null;
    readonly opcache?: {
      readonly enabled?: boolean;
      readonly memory_used?: number | null;
      readonly memory_free?: number | null;
      readonly hit_rate?: number | null;
      readonly cached_scripts?: number | null;
    } | null;
    readonly extensions?: readonly string[] | null;
    /** Null outside PHP-FPM. */
    readonly fpm?: {
      readonly pool?: string | null;
      readonly process_manager?: string | null;
      readonly start_since?: number | null;
      readonly accepted_conn?: number | null;
      readonly listen_queue?: number | null;
      readonly max_listen_queue?: number | null;
      readonly idle_processes?: number | null;
      readonly active_processes?: number | null;
      readonly total_processes?: number | null;
      readonly max_active_processes?: number | null;
      readonly max_children_reached?: number | null;
      readonly slow_requests?: number | null;
      /** The pool's `pm.*` and timeout directives from its pool file. */
      readonly settings?: Readonly<Record<string, string>> | null;
    } | null;
  };
  readonly inertia?: {
    readonly version?: string | null;
    /** Per top-level prop, from Inertia's DevTools (package 0.3.7+, inertia-laravel 3.3+). */
    readonly props?: Readonly<Record<string, InertiaPropMeta>> | null;
    /** Where the controller renders the page. */
    readonly render_source?: SourceLocation | null;
    /** The page component's file. */
    readonly component_path?: string | null;
  };
}
