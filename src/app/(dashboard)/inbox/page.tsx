"use client";

import { Suspense, useState, useCallback, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { CONVERSATION_SELECT, normalizeConversation } from "@/lib/inbox/conversations";
import type { Conversation, Message, Contact, ConversationStatus } from "@/types";
import { useRealtime } from "@/hooks/use-realtime";
import { ConversationList } from "@/components/inbox/conversation-list";
import { MessageThread } from "@/components/inbox/message-thread";
import { ContactSidebar } from "@/components/inbox/contact-sidebar";
import { WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";

const CONTACT_PANEL_STORAGE_KEY = "wacrm:inbox:contact-panel-open";

export default function InboxPage() {
  return (
    <Suspense fallback={null}>
      <InboxPageInner />
    </Suspense>
  );
}

function InboxPageInner() {
  const t = useTranslations("Inbox.page");
  const router = useRouter();
  const searchParams = useSearchParams();
  const deepLinkConvId = searchParams.get("c");

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [activeContact, setActiveContact] = useState<Contact | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [whatsappConnected, setWhatsappConnected] = useState<boolean | null>(null);
  const [resyncToken, setResyncToken] = useState(0);
  const [contactPanelOpen, setContactPanelOpen] = useState(true);

  const autoSelectedForDeepLinkRef = useRef<string | null>(null);
  const hydratingConvIdsRef = useRef<Set<string>>(new Set());
  const knownConvIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    knownConvIdsRef.current = new Set(conversations.map((conversation) => conversation.id));
  }, [conversations]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(CONTACT_PANEL_STORAGE_KEY);
      if (stored !== null) setContactPanelOpen(stored === "true");
    } catch {
      // Device persistence is best-effort.
    }
  }, []);

  const handleToggleContactPanel = useCallback(() => {
    setContactPanelOpen((previous) => {
      const next = !previous;
      try {
        localStorage.setItem(CONTACT_PANEL_STORAGE_KEY, String(next));
      } catch {
        // Device persistence is best-effort.
      }
      return next;
    });
  }, []);

  const hydrateConversation = useCallback(async (conversationId: string) => {
    if (hydratingConvIdsRef.current.has(conversationId)) return;
    hydratingConvIdsRef.current.add(conversationId);
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .eq("id", conversationId)
        .maybeSingle();
      if (error || !data) {
        if (error) console.error("Failed to hydrate conversation:", error.message);
        return;
      }
      const fetched = normalizeConversation(data);
      setConversations((previous) => {
        const existing = previous.find((conversation) => conversation.id === fetched.id);
        if (!existing) return [fetched, ...previous];
        return previous.map((conversation) =>
          conversation.id === fetched.id
            ? { ...conversation, contact: conversation.contact ?? fetched.contact }
            : conversation,
        );
      });
    } finally {
      hydratingConvIdsRef.current.delete(conversationId);
    }
  }, []);

  // Multi-channel connection health: the inbox is online when at least one
  // channel is connected. Do not use maybeSingle() against whatsapp_config;
  // multi-number accounts legitimately have several rows.
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/whatsapp/config?list=1", { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok) throw new Error(json.error || "Failed to read WhatsApp channels");
        if (!cancelled) {
          const channels = Array.isArray(json.channels) ? json.channels : [];
          setWhatsappConnected(channels.some((channel: { status?: string }) => channel.status === "connected"));
        }
      })
      .catch((error) => {
        console.error("Failed to check WhatsApp connection:", error);
        if (!cancelled) setWhatsappConnected(false);
      });
    return () => { cancelled = true; };
  }, []);

  const handleMessageEvent = useCallback(
    (event: { eventType: string; new: Message; old: Partial<Message> }) => {
      const newMessage = event.new;
      if (event.eventType === "INSERT") {
        if (activeConversation?.id === newMessage.conversation_id) {
          setMessages((previous) => {
            if (previous.some((message) => message.id === newMessage.id)) return previous;
            const withoutOptimistic = previous.filter((message) => !message.id.startsWith("temp-"));
            return [...withoutOptimistic, newMessage];
          });
        }

        if (knownConvIdsRef.current.has(newMessage.conversation_id)) {
          setConversations((previous) =>
            previous.map((conversation) =>
              conversation.id === newMessage.conversation_id
                ? {
                    ...conversation,
                    last_message_text: newMessage.content_text ?? "",
                    last_message_at: newMessage.created_at,
                    unread_count: activeConversation?.id === newMessage.conversation_id
                      ? 0
                      : conversation.unread_count + 1,
                  }
                : conversation,
            ),
          );
        } else {
          void hydrateConversation(newMessage.conversation_id);
        }
      } else if (event.eventType === "UPDATE") {
        setMessages((previous) =>
          previous.map((message) =>
            message.id === newMessage.id ? { ...message, ...newMessage } : message,
          ),
        );
      }
    },
    [activeConversation, hydrateConversation],
  );

  const handleConversationEvent = useCallback(
    (event: { eventType: string; new: Conversation; old: Partial<Conversation> }) => {
      const conversation = event.new;
      if (event.eventType === "INSERT") {
        if (!knownConvIdsRef.current.has(conversation.id)) {
          setConversations((previous) =>
            previous.some((row) => row.id === conversation.id)
              ? previous
              : [conversation, ...previous],
          );
          void hydrateConversation(conversation.id);
        }
        return;
      }

      if (event.eventType === "UPDATE") {
        if (knownConvIdsRef.current.has(conversation.id)) {
          const isActive = activeConversation?.id === conversation.id;
          setConversations((previous) =>
            previous.map((row) =>
              row.id === conversation.id
                ? { ...row, ...conversation, unread_count: isActive ? 0 : conversation.unread_count }
                : row,
            ),
          );
        } else {
          void hydrateConversation(conversation.id);
        }
        if (activeConversation?.id === conversation.id) {
          setActiveConversation((previous) => previous ? { ...previous, ...conversation } : previous);
        }
      }
    },
    [activeConversation, hydrateConversation],
  );

  const { isConnected } = useRealtime({
    channelName: "inbox-realtime",
    onMessageEvent: handleMessageEvent,
    onConversationEvent: handleConversationEvent,
    enabled: true,
  });

  const wasConnectedRef = useRef(false);
  const initialConnectDoneRef = useRef(false);
  useEffect(() => {
    if (isConnected && !wasConnectedRef.current) {
      if (initialConnectDoneRef.current) setResyncToken((value) => value + 1);
      else initialConnectDoneRef.current = true;
    }
    wasConnectedRef.current = isConnected;
  }, [isConnected]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") setResyncToken((value) => value + 1);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const handleManualRefresh = useCallback(() => setResyncToken((value) => value + 1), []);

  const handleConversationsLoaded = useCallback(
    (loaded: Conversation[]) => {
      setConversations(loaded);
      if (!deepLinkConvId || autoSelectedForDeepLinkRef.current === deepLinkConvId || loaded.length === 0) return;
      autoSelectedForDeepLinkRef.current = deepLinkConvId;
      if (activeConversation?.id === deepLinkConvId) return;
      const match = loaded.find((conversation) => conversation.id === deepLinkConvId);
      if (!match) return;
      setActiveConversation(match);
      setActiveContact(match.contact ?? null);
      setMessages([]);
      if (match.unread_count > 0) {
        setConversations((previous) =>
          previous.map((conversation) =>
            conversation.id === match.id ? { ...conversation, unread_count: 0 } : conversation,
          ),
        );
      }
    },
    [deepLinkConvId, activeConversation?.id],
  );

  const handleSelectConversation = useCallback(
    (conversation: Conversation) => {
      if (activeConversation?.id === conversation.id) return;
      setActiveConversation(conversation);
      setActiveContact(conversation.contact ?? null);
      setMessages([]);
      setConversations((previous) =>
        previous.map((row) =>
          row.id === conversation.id && row.unread_count > 0 ? { ...row, unread_count: 0 } : row,
        ),
      );
      autoSelectedForDeepLinkRef.current = conversation.id;
      router.replace(`/inbox?c=${conversation.id}`, { scroll: false });
    },
    [activeConversation?.id, router],
  );

  const handleCloseConversation = useCallback(() => {
    setActiveConversation(null);
    setActiveContact(null);
    setMessages([]);
    autoSelectedForDeepLinkRef.current = null;
    router.replace("/inbox", { scroll: false });
  }, [router]);

  const handleMessagesLoaded = useCallback((loaded: Message[]) => setMessages(loaded), []);
  const handleNewMessage = useCallback((message: Message) => {
    setMessages((previous) => previous.some((row) => row.id === message.id) ? previous : [...previous, message]);
  }, []);
  const handleUpdateMessage = useCallback((id: string, updates: Partial<Message>) => {
    setMessages((previous) => previous.map((message) => message.id === id ? { ...message, ...updates } : message));
  }, []);
  const handleStatusChange = useCallback((conversationId: string, status: ConversationStatus) => {
    setConversations((previous) => previous.map((conversation) => conversation.id === conversationId ? { ...conversation, status } : conversation));
    if (activeConversation?.id === conversationId) {
      setActiveConversation((previous) => previous ? { ...previous, status } : previous);
    }
  }, [activeConversation]);
  const handleAssignChange = useCallback((conversationId: string, assignedAgentId: string | null) => {
    setConversations((previous) => previous.map((conversation) => conversation.id === conversationId ? { ...conversation, assigned_agent_id: assignedAgentId ?? undefined } : conversation));
    if (activeConversation?.id === conversationId) {
      setActiveConversation((previous) => previous ? { ...previous, assigned_agent_id: assignedAgentId ?? undefined } : previous);
    }
  }, [activeConversation]);

  const hasActiveConversation = Boolean(activeConversation);

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden sm:-m-6">
      {whatsappConnected === false && (
        <div className="flex shrink-0 items-center justify-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2">
          <WifiOff className="h-4 w-4 text-amber-400" />
          <p className="text-xs text-amber-400">{t("whatsappNotConnected")}</p>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <div className={cn("flex h-full flex-1 lg:flex-none", hasActiveConversation ? "hidden lg:flex" : "flex")}>
          <ConversationList
            activeConversationId={activeConversation?.id ?? null}
            onSelect={handleSelectConversation}
            conversations={conversations}
            onConversationsLoaded={handleConversationsLoaded}
            resyncToken={resyncToken}
          />
        </div>

        <div className={cn("flex h-full min-w-0 flex-1 lg:flex", hasActiveConversation ? "flex" : "hidden lg:flex")}>
          <MessageThread
            conversation={activeConversation}
            contact={activeContact}
            messages={messages}
            onMessagesLoaded={handleMessagesLoaded}
            onNewMessage={handleNewMessage}
            onUpdateMessage={handleUpdateMessage}
            onStatusChange={handleStatusChange}
            onAssignChange={handleAssignChange}
            onBack={handleCloseConversation}
            resyncToken={resyncToken}
            onRefresh={handleManualRefresh}
            contactPanelOpen={contactPanelOpen}
            onToggleContactPanel={handleToggleContactPanel}
          />
        </div>

        {contactPanelOpen && (
          <div className="hidden lg:block">
            <ContactSidebar contact={activeContact} />
          </div>
        )}
      </div>
    </div>
  );
}
