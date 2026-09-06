'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Loader2, FileText, ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';

const categoryColors: Record<string, string> = {
  Marketing: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  Utility: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  Authentication: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
};

type ChannelTemplate = MessageTemplate & { whatsapp_config_id?: string | null };
type ChannelMeta = {
  id: string;
  label: string | null;
  phone_number_id: string;
  is_primary: boolean;
};

interface Step1Props {
  selectedTemplate: ChannelTemplate | null;
  onSelect: (template: ChannelTemplate) => void;
  onNext: () => void;
  onBack: () => void;
}

export function Step1ChooseTemplate({ selectedTemplate, onSelect, onNext, onBack }: Step1Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [templates, setTemplates] = useState<ChannelTemplate[]>([]);
  const [channels, setChannels] = useState<Map<string, ChannelMeta>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchTemplates() {
      try {
        const supabase = createClient();
        const [templateResult, channelResult] = await Promise.all([
          supabase
            .from('message_templates')
            .select('*')
            .eq('status', 'APPROVED')
            .not('whatsapp_config_id', 'is', null)
            .order('created_at', { ascending: false }),
          supabase
            .from('whatsapp_config')
            .select('id,label,phone_number_id,is_primary'),
        ]);

        if (templateResult.error) throw templateResult.error;
        if (channelResult.error) throw channelResult.error;

        setTemplates((templateResult.data as ChannelTemplate[] | null) ?? []);
        setChannels(
          new Map(
            ((channelResult.data as ChannelMeta[] | null) ?? []).map((channel) => [
              channel.id,
              channel,
            ]),
          ),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : t('chooseTemplate.errorLoad'));
      } finally {
        setLoading(false);
      }
    }

    void fetchTemplates();
  }, [t]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('chooseTemplate.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose the approved template from the WhatsApp number that should send this broadcast.
        </p>
      </div>

      {templates.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-border bg-card/50">
          <FileText className="mb-2 h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('chooseTemplate.noTemplates')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('chooseTemplate.createFirst')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => {
            const isSelected = selectedTemplate?.id === template.id;
            const catColor = categoryColors[template.category] ?? categoryColors.Utility;
            const channel = template.whatsapp_config_id
              ? channels.get(template.whatsapp_config_id)
              : undefined;

            return (
              <button
                key={template.id}
                type="button"
                onClick={() => onSelect(template)}
                className={`flex flex-col gap-3 rounded-xl border p-4 text-left transition-all ${
                  isSelected
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                    : 'border-border bg-card/50 hover:border-border hover:bg-card'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="min-w-0 truncate text-sm font-medium text-foreground">
                    {template.name}
                  </h3>
                  <span
                    className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${catColor}`}
                  >
                    {template.category}
                  </span>
                </div>
                <p className="line-clamp-3 text-xs text-muted-foreground">{template.body_text}</p>
                <div className="space-y-1 text-[10px] text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <span>{template.language ?? 'en_US'}</span>
                    {channel?.is_primary && <span>Primary</span>}
                  </div>
                  <p className="truncate font-medium text-foreground/80">
                    From: {channel?.label || channel?.phone_number_id || 'Unknown WhatsApp channel'}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="outline" onClick={onBack} className="border-border text-muted-foreground">
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!selectedTemplate?.whatsapp_config_id}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}