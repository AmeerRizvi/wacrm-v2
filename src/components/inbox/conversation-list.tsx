"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { CONVERSATION_SELECT, matchesContactFilters, normalizeConversations } from "@/lib/inbox/conversations";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus, Tag } from "@/types";
import { Search, ChevronDown, X, Smartphone } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  resyncToken?: number;
}

type Channel = { id: string; label: string | null; phone_number_id: string; is_primary: boolean };
type ChannelConversation = Conversation & { whatsapp_config_id?: string | null };
type InboxFilter = ConversationStatus | "all" | "unread";

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};

export function ConversationList({ activeConversationId, onSelect, conversations, onConversationsLoaded, resyncToken = 0 }: ConversationListProps) {
  const t = useTranslations("Inbox.conversationList");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [channelId, setChannelId] = useState<string>("all");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  const onLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => { onLoadedRef.current = onConversationsLoaded; });

  const filterOptions = useMemo(() => [
    { label: t("filterAll"), value: "all" as const },
    { label: t("filterUnread"), value: "unread" as const },
    { label: t("filterOpen"), value: "open" as const },
    { label: t("filterPending"), value: "pending" as const },
    { label: t("filterClosed"), value: "closed" as const },
  ], [t]);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase.from("conversations").select(CONVERSATION_SELECT).order("last_message_at", { ascending: false });
      if (cancelled) return;
      if (error) console.error("Failed to fetch conversations:", error);
      else onLoadedRef.current(normalizeConversations(data ?? []));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [resyncToken]);

  useEffect(() => {
    const supabase = createClient();
    void supabase.from("tags").select("*").order("name").then(({ data }) => data && setTags(data as Tag[]));
    void fetch("/api/whatsapp/config?list=1", { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => setChannels(json.channels ?? []))
      .catch(() => setChannels([]));
  }, []);

  const companies = useMemo(() => Array.from(new Set(conversations.map((c) => c.contact?.company?.trim()).filter((v): v is string => Boolean(v)))).sort(), [conversations]);
  const tagsById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags]);
  const channelById = useMemo(() => new Map(channels.map((channel) => [channel.id, channel])), [channels]);

  const filtered = useMemo(() => {
    let result = conversations as ChannelConversation[];
    if (channelId !== "all") result = result.filter((c) => c.whatsapp_config_id === channelId);
    if (filter === "unread") result = result.filter((c) => c.unread_count > 0);
    else if (filter !== "all") result = result.filter((c) => c.status === filter);
    if (selectedTagIds.length || selectedCompany !== null) result = result.filter((c) => matchesContactFilters(c, { tagIds: selectedTagIds, company: selectedCompany }));
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => [c.contact?.name, c.contact?.phone, c.last_message_text].some((v) => v?.toLowerCase().includes(q)));
    }
    return result;
  }, [conversations, channelId, filter, selectedTagIds, selectedCompany, search]);

  const toggleTag = useCallback((id: string) => setSelectedTagIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]), []);
  const activeFilter = filterOptions.find((o) => o.value === filter);
  const activeChannel = channels.find((c) => c.id === channelId);

  return (
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("searchPlaceholder")} className="border-border bg-muted pl-9 text-sm" />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {channels.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex h-7 max-w-44 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                <Smartphone className="h-3 w-3" />
                <span className="truncate">{channelId === "all" ? "All numbers" : activeChannel?.label || activeChannel?.phone_number_id || "Number"}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-60">
                <DropdownMenuItem onClick={() => setChannelId("all")} className={channelId === "all" ? "text-primary" : ""}>All numbers</DropdownMenuItem>
                {channels.map((channel) => (
                  <DropdownMenuItem key={channel.id} onClick={() => setChannelId(channel.id)} className={channelId === channel.id ? "text-primary" : ""}>
                    <span className="truncate">{channel.label || channel.phone_number_id}</span>{channel.is_primary && <span className="ml-auto text-[10px] text-muted-foreground">Primary</span>}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">{activeFilter?.label ?? t("filterAll")}<ChevronDown className="h-3 w-3" /></DropdownMenuTrigger>
            <DropdownMenuContent align="start">{filterOptions.map((opt) => <DropdownMenuItem key={opt.value} onClick={() => setFilter(opt.value)} className={filter === opt.value ? "text-primary" : ""}>{opt.label}</DropdownMenuItem>)}</DropdownMenuContent>
          </DropdownMenu>
          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger className={cn("inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-muted", selectedTagIds.length ? "text-primary" : "text-muted-foreground")}>{t("tags")}{selectedTagIds.length > 0 && <span className="rounded-full bg-primary px-1 text-[10px] text-primary-foreground">{selectedTagIds.length}</span>}<ChevronDown className="h-3 w-3" /></DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-64 w-56">{tags.map((tag) => <DropdownMenuCheckboxItem key={tag.id} checked={selectedTagIds.includes(tag.id)} onCheckedChange={() => toggleTag(tag.id)}>{tag.name}</DropdownMenuCheckboxItem>)}</DropdownMenuContent>
            </DropdownMenu>
          )}
          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex h-7 max-w-36 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted"><span className="truncate">{selectedCompany ?? t("company")}</span><ChevronDown className="h-3 w-3" /></DropdownMenuTrigger>
              <DropdownMenuContent align="start"><DropdownMenuItem onClick={() => setSelectedCompany(null)}>{t("allCompanies")}</DropdownMenuItem>{companies.map((co) => <DropdownMenuItem key={co} onClick={() => setSelectedCompany(co)}>{co}</DropdownMenuItem>)}</DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {(selectedTagIds.length > 0 || selectedCompany) && (
          <div className="flex flex-wrap gap-1">
            {selectedTagIds.map((id) => <button key={id} onClick={() => toggleTag(id)} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px]">{tagsById.get(id)?.name || t("tags")}<X className="h-3 w-3" /></button>)}
            {selectedCompany && <button onClick={() => setSelectedCompany(null)} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px]">{selectedCompany}<X className="h-3 w-3" /></button>}
          </div>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {loading ? <div className="flex justify-center py-12"><div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" /></div> : filtered.length === 0 ? <div className="px-4 py-12 text-center text-sm text-muted-foreground">{t("noConversations")}</div> : (
          <div className="flex flex-col">{filtered.map((conv) => <ConversationItem key={conv.id} conversation={conv} channel={conv.whatsapp_config_id ? channelById.get(conv.whatsapp_config_id) : undefined} showChannel={channelId === "all" && channels.length > 1} isActive={conv.id === activeConversationId} onSelect={onSelect} t={t} />)}</div>
        )}
      </ScrollArea>
    </div>
  );
}

function ConversationItem({ conversation, channel, showChannel, isActive, onSelect, t }: { conversation: ChannelConversation; channel?: Channel; showChannel: boolean; isActive: boolean; onSelect: (conversation: Conversation) => void; t: ReturnType<typeof useTranslations> }) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || t("unknown");
  const timeAgo = conversation.last_message_at ? formatDistanceToNow(new Date(conversation.last_message_at), { addSuffix: false }) : "";
  return (
    <button onClick={() => onSelect(conversation)} className={cn("flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50", isActive && "border-l-2 border-primary bg-muted/70") }>
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium">{contact?.avatar_url ? <img src={contact.avatar_url} alt={displayName} className="h-10 w-10 rounded-full object-cover" /> : displayName.charAt(0).toUpperCase()}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium">{displayName}</span><span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo}</span></div>
        {showChannel && channel && <div className="mt-0.5 truncate text-[10px] font-medium text-primary">{channel.label || channel.phone_number_id}</div>}
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">{conversation.last_message_text || t("noMessagesYet")}</p>
          <div className="flex shrink-0 items-center gap-1.5">{conversation.unread_count > 0 && <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">{conversation.unread_count}</span>}<span className={cn("h-2 w-2 rounded-full", STATUS_COLORS[conversation.status])} title={conversation.status} /></div>
        </div>
      </div>
    </button>
  );
}
