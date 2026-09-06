// ============================================================
// Template body resolution — the local `message_templates` row for a
// send, and the substituted body text we persist alongside it.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import type { MessageTemplate } from '@/types';

export function renderTemplateBody(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, raw) => {
    const idx = Number(raw) - 1;
    return params[idx] ?? `{{${raw}}}`;
  });
}

export function templateBodyParams(
  templateParams?: string[] | null,
  templateMessageParams?: unknown
): string[] {
  const structured =
    templateMessageParams &&
    typeof templateMessageParams === 'object' &&
    Array.isArray((templateMessageParams as { body?: unknown }).body)
      ? ((templateMessageParams as { body: unknown[] }).body.filter(
          (v): v is string => typeof v === 'string'
        ) as string[])
      : null;

  if (structured && structured.length > 0) return structured;
  return Array.isArray(templateParams) ? templateParams : [];
}

function baseLanguage(language: string): string {
  return language.toLowerCase().split(/[_-]/)[0];
}

export interface ResolvedTemplate {
  row: MessageTemplate | null;
  malformed: boolean;
  language: string;
}

/**
 * Resolve a local template copy. When `whatsappConfigId` is supplied the
 * lookup is bound to that exact WhatsApp channel/WABA. Legacy callers may
 * omit it; those reads still see account rows, which preserves behaviour
 * during migration while channel-aware send paths always pass it.
 */
export async function resolveTemplateRow(
  db: SupabaseClient,
  accountId: string,
  templateName: string,
  requestedLanguage?: string | null,
  whatsappConfigId?: string | null,
): Promise<ResolvedTemplate> {
  let query = db
    .from('message_templates')
    .select('*')
    .eq('account_id', accountId)
    .eq('name', templateName);

  if (whatsappConfigId) {
    query = query.eq('whatsapp_config_id', whatsappConfigId);
  }

  const { data } = await query;
  const rows = ((Array.isArray(data) ? data : []) as { language?: string }[])
    .slice()
    .sort((a, b) => (a.language ?? '').localeCompare(b.language ?? ''));
  const fallbackLanguage = requestedLanguage || 'en_US';

  if (rows.length === 0) {
    return { row: null, malformed: false, language: fallbackLanguage };
  }

  const pick = (): { language?: string } | undefined => {
    if (requestedLanguage) {
      const wanted = requestedLanguage.toLowerCase();
      const exact = rows.find((r) => r.language?.toLowerCase() === wanted);
      if (exact) return exact;
      const wantedBase = baseLanguage(requestedLanguage);
      return rows.find(
        (r) => r.language && baseLanguage(r.language) === wantedBase
      );
    }
    return (
      rows.find((r) => r.language === 'en_US') ??
      rows.find((r) => r.language === 'en') ??
      rows[0]
    );
  };

  const chosen = pick();
  if (!chosen) {
    return { row: null, malformed: false, language: fallbackLanguage };
  }

  if (!isMessageTemplate(chosen)) {
    return { row: null, malformed: true, language: fallbackLanguage };
  }

  return {
    row: chosen,
    malformed: false,
    language: requestedLanguage || chosen.language || 'en_US',
  };
}

export function templateContentText(
  row: MessageTemplate | null,
  params: string[],
  callerText?: string | null
): string | null {
  if (callerText) return callerText;
  if (!row?.body_text) return null;
  return renderTemplateBody(row.body_text, params);
}
