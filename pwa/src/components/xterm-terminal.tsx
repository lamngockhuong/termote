import { useEffect, useRef, useImperativeHandle, forwardRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export interface XtermTerminalHandle {
  sendInput: (data: string) => void
  sendCommand: (command: string) => void
  focus: () => void
}

interface Props {
  fontSize?: number
  theme?: 'light' | 'dark'
  onConnect?: () => void
  onDisconnect?: () => void
}

const THEMES = {
  light: { background: '#ffffff', foreground: '#1e1e1e', cursor: '#1e1e1e' },
  dark: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4' },
}

export const XtermTerminal = forwardRef<XtermTerminalHandle, Props>(
  ({ fontSize = 14, theme = 'dark', onConnect, onDisconnect }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null)
    const terminalRef = useRef<Terminal | null>(null)
    const wsRef = useRef<WebSocket | null>(null)
    const fitAddonRef = useRef<FitAddon | null>(null)
    const mountedRef = useRef(true)
    const connectingRef = useRef(false)
    const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // Store callbacks in refs to avoid dependency issues
    const onConnectRef = useRef(onConnect)
    const onDisconnectRef = useRef(onDisconnect)
    onConnectRef.current = onConnect
    onDisconnectRef.current = onDisconnect

    // Expose methods to parent
    useImperativeHandle(ref, () => ({
      sendInput: (data: string) => {
        const ws = wsRef.current
        if (ws?.readyState === WebSocket.OPEN) {
          // ttyd expects text: '0' + data (ASCII '0' = input)
          ws.send('0' + data)
        }
      },
      sendCommand: (command: string) => {
        const ws = wsRef.current
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send('0' + command + '\n')
        }
      },
      focus: () => {
        terminalRef.current?.focus()
      },
    }))

    const connect = useCallback(async () => {
      if (!mountedRef.current || connectingRef.current) return
      if (wsRef.current?.readyState === WebSocket.OPEN) return

      connectingRef.current = true
      const terminal = terminalRef.current
      if (!terminal) {
        connectingRef.current = false
        return
      }

      try {
        const tokenRes = await fetch('/terminal/token')
        const tokenData = await tokenRes.json()
        const token = tokenData.token || ''

        if (!mountedRef.current) {
          connectingRef.current = false
          return
        }

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const wsUrl = `${protocol}//${window.location.host}/terminal/ws${token ? `?token=${token}` : ''}`

        const ws = new WebSocket(wsUrl)

        ws.onopen = () => {
          console.log('[xterm] WebSocket opened, readyState:', ws.readyState)
          connectingRef.current = false
          onConnectRef.current?.()

          // ttyd expects first message to be JSON with AuthToken + size
          const { cols, rows } = terminal
          const initMsg = JSON.stringify({ AuthToken: token, columns: cols, rows: rows })
          console.log('[xterm] Sending init:', initMsg)
          ws.send(initMsg)
        }

        ws.onmessage = (event) => {
          console.log('[xterm] Message received, data type:', typeof event.data, event.data instanceof Blob ? 'Blob' : '')
          // Handle both text and binary messages
          if (typeof event.data === 'string') {
            // Text message: <type><data>
            const msg = event.data
            console.log('[xterm] Text msg len:', msg.length, 'type char:', msg.charCodeAt(0))
            if (msg.length > 0) {
              const msgType = msg.charCodeAt(0)
              if (msgType === 48) { // '0' = output
                terminal.write(msg.substring(1))
              } else if (msgType === 49) { // '1' = title
                console.log('[xterm] Title:', msg.substring(1))
              } else if (msgType === 50) { // '2' = prefs
                console.log('[xterm] Prefs:', msg.substring(1))
              }
            }
          } else if (event.data instanceof Blob) {
            // Binary blob - read as text
            console.log('[xterm] Blob size:', event.data.size)
            event.data.text().then((text) => {
              console.log('[xterm] Blob text len:', text.length, 'type char:', text.charCodeAt(0))
              if (text.length > 0) {
                const msgType = text.charCodeAt(0)
                if (msgType === 48) {
                  terminal.write(text.substring(1))
                }
              }
            })
          }
        }

        ws.onclose = (event) => {
          console.log('[xterm] Disconnected, code:', event.code, 'reason:', event.reason, 'wasClean:', event.wasClean)
          connectingRef.current = false
          onDisconnectRef.current?.()
          wsRef.current = null
          // Only reconnect if still mounted
          if (mountedRef.current) {
            reconnectTimeoutRef.current = setTimeout(connect, 3000)
          }
        }

        ws.onerror = (e) => {
          console.log('[xterm] Error:', e)
          connectingRef.current = false
        }

        wsRef.current = ws

        terminal.onData((data) => {
          if (ws.readyState === WebSocket.OPEN) {
            // ttyd expects text: '0' + data
            ws.send('0' + data)
          }
        })

        terminal.onResize(({ cols, rows }) => {
          if (ws.readyState === WebSocket.OPEN) {
            // ttyd expects text: '1' + JSON resize
            ws.send('1' + JSON.stringify({ columns: cols, rows: rows }))
          }
        })
      } catch (err) {
        console.error('[xterm] Connection failed:', err)
        connectingRef.current = false
        if (mountedRef.current) {
          reconnectTimeoutRef.current = setTimeout(connect, 3000)
        }
      }
    }, [])

    // Initialize terminal once
    useEffect(() => {
      if (!containerRef.current || terminalRef.current) return

      mountedRef.current = true

      const terminal = new Terminal({
        fontSize,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        theme: THEMES[theme],
        cursorBlink: true,
        allowProposedApi: true,
      })

      const fitAddon = new FitAddon()
      terminal.loadAddon(fitAddon)
      terminal.open(containerRef.current)
      fitAddon.fit()

      terminalRef.current = terminal
      fitAddonRef.current = fitAddon

      connect()

      const handleResize = () => fitAddon.fit()
      window.addEventListener('resize', handleResize)

      return () => {
        mountedRef.current = false
        window.removeEventListener('resize', handleResize)
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current)
        }
        wsRef.current?.close()
        terminal.dispose()
        terminalRef.current = null
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connect])

    // Update font size and theme
    useEffect(() => {
      if (terminalRef.current) {
        terminalRef.current.options.fontSize = fontSize
        terminalRef.current.options.theme = THEMES[theme]
        fitAddonRef.current?.fit()
      }
    }, [fontSize, theme])

    return (
      <div
        ref={containerRef}
        className={`flex-1 w-full h-full ${theme === 'light' ? 'bg-white' : 'bg-[#1e1e1e]'}`}
        style={{ padding: '4px' }}
      />
    )
  }
)

XtermTerminal.displayName = 'XtermTerminal'
