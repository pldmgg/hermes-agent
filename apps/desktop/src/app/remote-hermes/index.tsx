import {
  AssistantRuntimeProvider,
  ExportedMessageRepository,
  type ThreadMessage
} from '@assistant-ui/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { formatRefValue } from '@/components/assistant-ui/directive-text'
import { Thread } from '@/components/assistant-ui/thread'
import { Backdrop } from '@/components/Backdrop'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { ChatMessage } from '@/lib/chat-messages'
import { toChatMessages } from '@/lib/chat-messages'
import { attachmentDisplayText, attachmentId, pathLabel, toRuntimeMessage } from '@/lib/chat-runtime'
import { useIncrementalExternalStoreRuntime } from '@/lib/incremental-external-store-runtime'
import { Clipboard, FileText, FolderOpen, ImageIcon, Link, MessageSquareText } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { ComposerAttachment } from '@/store/composer'
import { notify, notifyError } from '@/store/notifications'
import type { SessionMessage } from '@/types/hermes'

import { AttachmentList } from '../chat/composer/attachments'
import { GHOST_ICON_BTN, PRIMARY_ICON_BTN } from '../chat/composer/controls'
import { ContextMenuItem } from '../chat/composer/context-menu'
import { UrlDialog } from '../chat/composer/url-dialog'
import { REMOTE_HERMES_ROUTE } from '../routes'
import { titlebarHeaderBaseClass, titlebarHeaderShadowClass } from '../shell/titlebar'

const API_ROOT = '/api/plugins/remote-hermes'
const REMOTE_FOLDER_MAX_DEPTH = 2
const REMOTE_FOLDER_MAX_ENTRIES = 200

const PROMPT_SNIPPETS = [
  {
    description: 'Ask for a focused review with concrete findings.',
    label: 'Code review',
    text: 'Please review this for correctness, maintainability, security issues, and edge cases. Return prioritized findings with concrete fixes.'
  },
  {
    description: 'Turn attached context into a clear implementation plan.',
    label: 'Implementation plan',
    text: 'Please create a concise implementation plan from this context. Include risks, files/components likely involved, and verification steps.'
  },
  {
    description: 'Explain the attached context in plain language.',
    label: 'Explain this',
    text: 'Please explain this context in plain language, call out the important details, and summarize what I should do next.'
  }
]

function pluginAssetUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, '')}/dashboard-plugins/remote-hermes/${path.replace(/^\/+/, '')}`
}

interface RemoteMessagesResponse {
  session_id: string
  messages: SessionMessage[]
  model?: null | string
  remote_model?: null | string
  remote_profile?: null | string
  remote_provider?: null | string
  remote_version?: null | string
  session?: {
    id?: string
    model?: null | string
    remote_model?: null | string
    remote_profile?: null | string
    remote_provider?: null | string
    title?: null | string
  } | null
  total?: number
  shown?: number
}

interface RemotePromptResponse {
  ok?: boolean
  session_id?: string
  text?: string
}

interface RemotePromptPayload {
  text: string
  attachments: ComposerAttachment[]
}

function remoteSessionTitle(sessionId: string, messages: ChatMessage[]): string {
  const firstUser = messages.find(message => message.role === 'user')
  const text = firstUser?.parts
    .filter((part): part is Extract<(typeof firstUser.parts)[number], { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .join('')
    .trim()

  return text ? text.slice(0, 80) : sessionId
}

function remoteModelLabel(data?: RemoteMessagesResponse): string {
  return String(data?.remote_model || data?.model || data?.session?.remote_model || data?.session?.model || '').trim()
}

function remoteProfileLabel(data?: RemoteMessagesResponse): string {
  return String(data?.remote_profile || data?.session?.remote_profile || '').trim()
}

function remoteProviderLabel(data?: RemoteMessagesResponse): string {
  return String(data?.remote_provider || data?.session?.remote_provider || '').trim()
}

function RemoteMetadataPill({
  label,
  value,
  tone
}: {
  label: string
  value: string
  tone: 'profile' | 'model'
}) {
  if (!value) {
    return null
  }

  const toneClasses =
    tone === 'profile'
      ? 'border-indigo-300/70 bg-indigo-700 text-white shadow-[0_0_0_1px_rgba(129,140,248,0.25)]'
      : 'border-emerald-300/70 bg-emerald-700 text-white shadow-[0_0_0_1px_rgba(52,211,153,0.25)]'

  return (
    <span
      className={cn(
        'max-w-[16rem] truncate rounded-full border px-2.5 py-1 text-[0.65rem] font-medium leading-none shadow-sm',
        toneClasses
      )}
      title={`${label}: ${value}`}
    >
      <span className="font-semibold text-white/80">{label}</span> {value}
    </span>
  )
}

function useRemoteSessionId(): string {
  const location = useLocation()

  return new URLSearchParams(location.search).get('session') || ''
}

function remoteAttachmentRef(kind: ComposerAttachment['kind'], value: string) {
  return `@${kind}:${formatRefValue(value)}`
}

function makeRemoteAttachment(kind: ComposerAttachment['kind'], value: string, extra: Partial<ComposerAttachment> = {}): ComposerAttachment {
  return {
    id: attachmentId(kind, value),
    kind,
    label: extra.label || pathLabel(value),
    detail: extra.detail ?? value,
    refText: extra.refText ?? remoteAttachmentRef(kind, value),
    path: extra.path,
    previewUrl: extra.previewUrl
  }
}

async function readRemoteAttachmentFileBlock(attachment: ComposerAttachment): Promise<string> {
  const filePath = attachment.path || attachment.detail || attachment.label

  if (!filePath) {
    return ''
  }

  try {
    const result = await window.hermesDesktop.readFileText(filePath)
    const size = result.byteSize ? ` (${result.byteSize} bytes${result.truncated ? ', truncated' : ''})` : ''

    if (result.binary) {
      return `Attached file: ${filePath}${size}\n[Binary file; contents were not inlined into the remote prompt.]`
    }

    const language = result.language || ''
    return [`Attached file: ${filePath}${size}`, '```' + language, result.text || '', '```'].join('\n')
  } catch (error) {
    return `Attached file: ${filePath}\n[Could not read local file for remote prompt: ${error instanceof Error ? error.message : String(error)}]`
  }
}

async function listFolderTree(root: string): Promise<string> {
  const lines: string[] = [root]
  let count = 0

  async function walk(dir: string, depth: number, prefix: string) {
    if (depth > REMOTE_FOLDER_MAX_DEPTH || count >= REMOTE_FOLDER_MAX_ENTRIES) {
      return
    }

    const result = await window.hermesDesktop.readDir(dir)
    if (result.error) {
      lines.push(`${prefix}[error: ${result.error}]`)
      return
    }

    const entries = [...result.entries].sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))

    for (const entry of entries) {
      if (count >= REMOTE_FOLDER_MAX_ENTRIES) {
        lines.push(`${prefix}…`)
        return
      }

      count += 1
      lines.push(`${prefix}${entry.isDirectory ? '📁' : '📄'} ${entry.name}`)

      if (entry.isDirectory) {
        await walk(entry.path, depth + 1, `${prefix}  `)
      }
    }
  }

  try {
    await walk(root, 0, '')
  } catch (error) {
    lines.push(`[Could not read local folder for remote prompt: ${error instanceof Error ? error.message : String(error)}]`)
  }

  return lines.join('\n')
}

async function remoteAttachmentBlocks(attachments: ComposerAttachment[]): Promise<string[]> {
  const blocks: string[] = []

  for (const attachment of attachments) {
    if (attachment.kind === 'file') {
      const block = await readRemoteAttachmentFileBlock(attachment)
      if (block) blocks.push(block)
    } else if (attachment.kind === 'folder') {
      const folderPath = attachment.path || attachment.detail || attachment.label
      if (folderPath) {
        blocks.push(`Attached folder: ${folderPath}\n\`\`\`text\n${await listFolderTree(folderPath)}\n\`\`\``)
      }
    } else {
      const display = attachmentDisplayText(attachment) || attachment.refText || attachment.detail || attachment.label
      if (display) blocks.push(display)
    }
  }

  return blocks
}

async function buildRemotePromptText(text: string, attachments: ComposerAttachment[]): Promise<string> {
  const blocks = await remoteAttachmentBlocks(attachments)
  const visible = text.trim()

  if (!blocks.length) {
    return visible
  }

  return [blocks.join('\n\n'), visible].filter(Boolean).join('\n\n')
}

function RemoteHermesSessionView({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate()
  const runtimeMessageCacheRef = useRef(new WeakMap<ChatMessage, ThreadMessage>())

  const messagesQuery = useQuery<RemoteMessagesResponse>({
    queryKey: ['remote-hermes-session', sessionId],
    queryFn: () =>
      window.hermesDesktop.api<RemoteMessagesResponse>({
        path: `${API_ROOT}/sessions/${encodeURIComponent(sessionId)}/messages?last=0&roles=user,assistant,tool`,
        timeoutMs: 120_000
      }),
    enabled: Boolean(sessionId)
  })

  const sendMutation = useMutation<RemotePromptResponse, Error, RemotePromptPayload>({
    mutationFn: async payload => {
      const text = await buildRemotePromptText(payload.text, payload.attachments)

      return window.hermesDesktop.api<RemotePromptResponse>({
        path: `${API_ROOT}/sessions/${encodeURIComponent(sessionId)}/prompt`,
        method: 'POST',
        body: { text },
        timeoutMs: 240_000
      })
    },
    onSuccess: () => {
      void messagesQuery.refetch()
    }
  })

  const messages = useMemo(
    () => toChatMessages(messagesQuery.data?.messages ?? []),
    [messagesQuery.data?.messages]
  )

  const title = remoteSessionTitle(sessionId, messages)
  const remoteModel = remoteModelLabel(messagesQuery.data)
  const remoteProfile = remoteProfileLabel(messagesQuery.data)
  const remoteProvider = remoteProviderLabel(messagesQuery.data)

  const runtimeMessageRepository = useMemo(() => {
    const items: { message: ThreadMessage; parentId: string | null }[] = []
    const branchParentByGroup = new Map<string, string | null>()
    let visibleParentId: string | null = null
    let headId: string | null = null

    for (const message of messages) {
      let parentId = visibleParentId

      if (message.role === 'assistant' && message.branchGroupId) {
        if (!branchParentByGroup.has(message.branchGroupId)) {
          branchParentByGroup.set(message.branchGroupId, visibleParentId)
        }

        parentId = branchParentByGroup.get(message.branchGroupId) ?? null
      }

      const cachedMessage = runtimeMessageCacheRef.current.get(message)
      const runtimeMessage = cachedMessage ?? toRuntimeMessage(message)

      if (!cachedMessage) {
        runtimeMessageCacheRef.current.set(message, runtimeMessage)
      }

      items.push({ message: runtimeMessage, parentId })

      if (!message.hidden) {
        visibleParentId = message.id
        headId = message.id
      }
    }

    return ExportedMessageRepository.fromBranchableArray(items, { headId })
  }, [messages])

  const runtime = useIncrementalExternalStoreRuntime<ThreadMessage>({
    messageRepository: runtimeMessageRepository,
    isRunning: false,
    setMessages: () => undefined,
    onNew: async () => undefined,
    onEdit: async () => undefined,
    onCancel: async () => undefined,
    onReload: async () => undefined
  })

  return (
    <div className="relative isolate flex h-full min-w-0 flex-col overflow-hidden bg-(--ui-chat-surface-background)">
      <Backdrop />
      <header className={cn(titlebarHeaderBaseClass, titlebarHeaderShadowClass)}>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Button
            className="pointer-events-auto h-6 min-w-0 gap-1 border border-transparent bg-transparent px-2 py-0 text-(--ui-text-secondary) hover:border-(--ui-stroke-tertiary) hover:bg-(--ui-control-hover-background) hover:text-foreground [-webkit-app-region:no-drag]"
            onClick={() => navigate(REMOTE_HERMES_ROUTE)}
            title="Back to Remote Hermes controls"
            type="button"
            variant="ghost"
          >
            <Codicon className="shrink-0 text-(--ui-text-tertiary)" name="globe" size="0.8125rem" />
            <h2 className="max-w-[38vw] truncate text-[0.75rem] font-medium leading-none">{title}</h2>
          </Button>
          <div className="pointer-events-auto flex min-w-0 shrink items-center gap-1 [-webkit-app-region:no-drag]">
            <RemoteMetadataPill label="remote profile" value={remoteProfile} tone="profile" />
            <RemoteMetadataPill
              label="remote model"
              value={remoteProvider ? `${remoteProvider}/${remoteModel}` : remoteModel}
              tone="model"
            />
          </div>
        </div>
      </header>

      <div className="relative min-h-0 max-w-full flex-1 overflow-hidden bg-(--ui-chat-surface-background) contain-[layout_paint]">
        <AssistantRuntimeProvider runtime={runtime}>
          <Thread
            clampToComposer={false}
            loading={messagesQuery.isLoading ? 'session' : sendMutation.isPending ? 'response' : undefined}
            sessionId={sessionId}
            sessionKey={`remote-hermes:${sessionId}`}
          />
        </AssistantRuntimeProvider>
        {messagesQuery.isError && (
          <div className="absolute inset-x-4 top-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <div className="font-semibold">Remote Hermes session failed to load</div>
            <div className="mt-1 font-mono text-xs">
              {messagesQuery.error instanceof Error ? messagesQuery.error.message : String(messagesQuery.error)}
            </div>
          </div>
        )}
      </div>
      <RemoteHermesComposer
        disabled={messagesQuery.isLoading || sendMutation.isPending}
        error={sendMutation.error instanceof Error ? sendMutation.error.message : sendMutation.error ? String(sendMutation.error) : ''}
        onSubmit={payload => sendMutation.mutate(payload)}
        sending={sendMutation.isPending}
      />
    </div>
  )
}

function RemoteHermesComposer({
  disabled,
  error,
  onSubmit,
  sending
}: {
  disabled: boolean
  error: string
  onSubmit: (payload: RemotePromptPayload) => void
  sending: boolean
}) {
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [urlOpen, setUrlOpen] = useState(false)
  const [urlValue, setUrlValue] = useState('')
  const urlInputRef = useRef<HTMLInputElement | null>(null)
  const trimmed = draft.trim()
  const hasPayload = trimmed.length > 0 || attachments.length > 0

  useEffect(() => {
    if (urlOpen) {
      window.requestAnimationFrame(() => urlInputRef.current?.focus({ preventScroll: true }))
    }
  }, [urlOpen])

  const addAttachment = (attachment: ComposerAttachment) => {
    setAttachments(current => {
      const index = current.findIndex(item => item.id === attachment.id)

      if (index === -1) {
        return [...current, attachment]
      }

      const next = [...current]
      next[index] = attachment
      return next
    })
  }

  const pickFiles = async () => {
    const paths = await window.hermesDesktop.selectPaths({ title: 'Add files as remote context' })
    for (const path of paths || []) {
      addAttachment(makeRemoteAttachment('file', path, { path }))
    }
  }

  const pickFolders = async () => {
    const paths = await window.hermesDesktop.selectPaths({ directories: true, title: 'Add folders as remote context' })
    for (const path of paths || []) {
      addAttachment(makeRemoteAttachment('folder', path, { path }))
    }
  }

  const pickImages = async () => {
    const paths = await window.hermesDesktop.selectPaths({
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff'] }],
      title: 'Add images as remote context'
    })

    for (const path of paths || []) {
      const base = makeRemoteAttachment('image', path, { path })
      addAttachment(base)
      try {
        const previewUrl = await window.hermesDesktop.readFileDataUrl(path)
        addAttachment({ ...base, previewUrl })
      } catch (err) {
        notifyError(err, 'Image preview unavailable')
      }
    }
  }

  const pasteClipboardImage = async () => {
    try {
      const path = await window.hermesDesktop.saveClipboardImage()
      if (!path) {
        notify({ kind: 'warning', title: 'Clipboard', message: 'No clipboard image found' })
        return
      }

      const base = makeRemoteAttachment('image', path, { path })
      addAttachment(base)
      const previewUrl = await window.hermesDesktop.readFileDataUrl(path)
      addAttachment({ ...base, previewUrl })
    } catch (err) {
      notifyError(err, 'Could not paste clipboard image')
    }
  }

  const submitUrl = () => {
    const url = urlValue.trim()
    if (!/^https?:\/\//i.test(url)) {
      return
    }

    addAttachment(makeRemoteAttachment('url', url, { detail: url, label: url, refText: `@url:${formatRefValue(url)}` }))
    setUrlValue('')
    setUrlOpen(false)
  }

  const insertSnippet = (text: string) => {
    setDraft(current => [current, text].filter(Boolean).join(current && !current.endsWith('\n') ? '\n' : ''))
  }

  const submit = () => {
    if (!hasPayload || disabled) {
      return
    }

    onSubmit({ text: trimmed, attachments })
    setDraft('')
    setAttachments([])
  }

  return (
    <div className="shrink-0 bg-linear-to-b from-transparent to-(--ui-chat-surface-background) px-0 pb-[var(--composer-shell-pad-block-end)] pt-2">
      <form
        className="mx-auto grid w-[min(var(--composer-width),calc(100%-2rem))] max-w-full gap-(--composer-row-gap) rounded-2xl"
        onSubmit={event => {
          event.preventDefault()
          submit()
        }}
      >
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
        {attachments.length > 0 && (
          <AttachmentList attachments={attachments} onRemove={id => setAttachments(current => current.filter(item => item.id !== id))} />
        )}
        <div className="relative isolate rounded-[inherit] border border-[color-mix(in_srgb,var(--dt-composer-ring)_calc(18%*var(--composer-ring-strength)),var(--dt-input))] shadow-sm transition-[border-color] duration-200 ease-out focus-within:border-[color-mix(in_srgb,var(--dt-composer-ring)_calc(45%*var(--composer-ring-strength)),transparent)]">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 rounded-[inherit] bg-[color-mix(in_srgb,var(--dt-card)_72%,transparent)] backdrop-blur-[0.75rem] backdrop-saturate-[1.12] [-webkit-backdrop-filter:blur(0.75rem)_saturate(1.12)]"
          />
          <div className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-(--composer-control-gap) overflow-hidden rounded-[inherit] px-(--composer-surface-pad-x) py-(--composer-surface-pad-y)">
            <div className="flex items-center">
              <RemoteHermesAttachMenu
                disabled={disabled}
                onOpenUrlDialog={() => setUrlOpen(true)}
                onPasteClipboardImage={() => void pasteClipboardImage()}
                onPickFiles={() => void pickFiles()}
                onPickFolders={() => void pickFolders()}
                onPickImages={() => void pickImages()}
                onSnippet={insertSnippet}
              />
            </div>
            <textarea
              className="min-h-(--composer-input-min-height) max-h-(--composer-input-max-height) min-w-(--composer-input-inline-min-width) w-full resize-none bg-transparent py-1 pr-1 text-sm leading-normal text-foreground outline-none placeholder:text-muted-foreground/60 disabled:opacity-60"
              disabled={disabled}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  submit()
                }
              }}
              placeholder={sending ? 'Waiting for remote Hermes…' : 'Send a message or attach remote context…'}
              rows={1}
              value={draft}
            />
            <div className="flex items-center justify-end">
              <Button
                className={PRIMARY_ICON_BTN}
                disabled={!hasPayload || disabled}
                size="icon"
                title="Send to remote Hermes"
                type="submit"
              >
                <Codicon name={sending ? 'loading' : 'arrow-up'} size="1rem" spinning={sending} />
              </Button>
            </div>
          </div>
        </div>
        {attachments.some(item => item.kind === 'image') && (
          <p className="px-2 text-[0.7rem] text-(--ui-text-tertiary)">
            Remote bridge is text-only: images are sent as @image path references; text files are inlined and folders send a bounded tree listing.
          </p>
        )}
      </form>
      <UrlDialog inputRef={urlInputRef} onChange={setUrlValue} onOpenChange={setUrlOpen} onSubmit={submitUrl} open={urlOpen} value={urlValue} />
    </div>
  )
}

function RemoteHermesAttachMenu({
  disabled,
  onOpenUrlDialog,
  onPasteClipboardImage,
  onPickFiles,
  onPickFolders,
  onPickImages,
  onSnippet
}: {
  disabled: boolean
  onOpenUrlDialog: () => void
  onPasteClipboardImage: () => void
  onPickFiles: () => void
  onPickFolders: () => void
  onPickImages: () => void
  onSnippet: (text: string) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Attach remote context"
          className={cn(GHOST_ICON_BTN, 'data-[state=open]:bg-(--chrome-action-hover) data-[state=open]:text-foreground')}
          disabled={disabled}
          size="icon"
          title="Attach remote context"
          type="button"
          variant="ghost"
        >
          <Codicon name="add" size="1rem" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64" side="top" sideOffset={10}>
        <DropdownMenuLabel className="text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground/85">
          Attach
        </DropdownMenuLabel>
        <ContextMenuItem icon={FileText} onSelect={onPickFiles}>Files</ContextMenuItem>
        <ContextMenuItem icon={FolderOpen} onSelect={onPickFolders}>Folder</ContextMenuItem>
        <ContextMenuItem icon={ImageIcon} onSelect={onPickImages}>Images</ContextMenuItem>
        <ContextMenuItem icon={Clipboard} onSelect={onPasteClipboardImage}>Paste image</ContextMenuItem>
        <ContextMenuItem icon={Link} onSelect={onOpenUrlDialog}>URL</ContextMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground/85">
          Prompt snippets
        </DropdownMenuLabel>
        {PROMPT_SNIPPETS.map(snippet => (
          <DropdownMenuItem key={snippet.label} onSelect={() => onSnippet(snippet.text)}>
            <MessageSquareText />
            <span className="grid min-w-0">
              <span>{snippet.label}</span>
              <span className="truncate text-[0.68rem] text-muted-foreground/80">{snippet.description}</span>
            </span>
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />
        <div className="px-2 py-1 text-[0.7rem] text-muted-foreground/80">
          Files are read locally and inlined before sending to remote Hermes.
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function RemoteHermesView() {
  const sessionId = useRemoteSessionId()

  if (sessionId) {
    return <RemoteHermesSessionView sessionId={sessionId} />
  }

  return <RemoteHermesPluginView />
}

function RemoteHermesPluginView() {
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const cssId = 'remote-hermes-plugin-css'
    const scriptId = 'remote-hermes-plugin-script'

    async function loadPlugin() {
      try {
        setLoadError(null)
        const connection = await window.hermesDesktop.getConnection()
        if (cancelled) return
        const baseUrl = connection.baseUrl
        if (!baseUrl) throw new Error('Desktop backend connection did not include a baseUrl')

        let css = document.getElementById(cssId) as HTMLLinkElement | null
        if (!css) {
          css = document.createElement('link')
          css.id = cssId
          css.rel = 'stylesheet'
          document.head.appendChild(css)
        }
        css.href = pluginAssetUrl(baseUrl, 'dist/style.css')

        document.getElementById(scriptId)?.remove()
        const script = document.createElement('script')
        script.id = scriptId
        script.src = `${pluginAssetUrl(baseUrl, 'dist/index.js')}?v=${Date.now()}`
        script.async = false
        script.onerror = () => {
          setLoadError(`Failed to load Remote Hermes plugin from ${script.src}`)
        }
        document.body.appendChild(script)
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error))
      }
    }

    void loadPlugin()
    return () => {
      cancelled = true
      document.getElementById(scriptId)?.remove()
    }
  }, [])

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-auto bg-(--ui-chat-surface-background) pt-(--titlebar-height)">
      {loadError ? (
        <div className="m-4 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="font-semibold">Remote Hermes plugin failed to load</div>
          <div className="mt-1 font-mono text-xs">{loadError}</div>
        </div>
      ) : null}
      <div id="hermes-plugin-root" data-plugin-root className="min-h-full" />
    </div>
  )
}
