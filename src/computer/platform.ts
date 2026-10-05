import type { WorkerClient } from '../client.js'
import { isSettled, run, runChecked } from './exec.js'

/**
 * A computer-use target platform. Each method turns one logical operation into
 * sandbox command(s) and parses the result. The extension stays platform-
 * agnostic: tools call this interface, never a raw command.
 *
 * Linux  -> xa11y CLI over AT-SPI2 (accessibility tree) + X11 input.
 * Android -> adb + uiautomator (XML dump) + `input` (tap/swipe/text/keyevent).
 * Windows/macOS -> xa11y has backends (UI Automation / AXUIElement) and the VM
 *                  sandbox images ship the CLI, so the SAME xa11y path drives
 *                  them (only the screenshot temp path differs).
 */
export interface AppInfo {
  pid: string
  name: string
  focused: boolean
}

export interface Platform {
  readonly id: 'linux' | 'android' | 'windows' | 'macos'
  /** Verify the tool the platform needs is present; throws a clear error. */
  probe(): Promise<void>
  apps(): Promise<AppInfo[]>
  /** Accessibility-tree dump text (already formatted for the model). */
  snapshot(app: string, depth: number): Promise<string>
  /** Find by selector; returns formatted lines (pretty|bounds|center). */
  find(selector: string, app: string, output: string): Promise<string>
  /** Perform an accessibility action on a target ref/selector. */
  action(
    action: string,
    target: string,
    value: string,
    app: string,
  ): Promise<void>
  click(x: number, y: number, button: string, count: number): Promise<void>
  typeText(text: string, target: string): Promise<void>
  key(key: string, held: string[]): Promise<void>
  scroll(x: number, y: number, dx: number, dy: number): Promise<void>
  drag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    durationMs: number,
  ): Promise<void>
  /** Capture the screen to a PNG file *inside the sandbox*; return its path. */
  screenshot(
    region: string,
  ): Promise<{ path: string; width: number; height: number }>
}

/** Parse `pid\tname[\tfocused]` lines (xa11y apps). */
function parseApps(out: string): AppInfo[] {
  const apps: AppInfo[] = []
  for (const line of out.split('\n')) {
    const t = line.trim()
    if (t === '' || t.startsWith('No applications')) continue
    const parts = t.split('\t')
    if (parts.length < 2) continue
    apps.push({
      pid: parts[0] ?? '',
      name: parts[1] ?? '',
      focused: parts[2] === 'focused',
    })
  }
  return apps
}

/** Numeric arg guard for adb input coordinates. */
function coord(n: number): number {
  return Math.round(n)
}

// ---------------------------------------------------------------------------
// Desktop (Linux X11/AT-SPI2, Windows UI Automation, macOS AXUIElement) via
// the `xa11y` CLI.
//
// The CLI is cross-platform and its argument surface is identical on all
// three, and the agent-worker's builtin shell (mvdan/sh) parses the same
// command line on each, so ONE implementation drives all three. Only the
// screenshot temp path differs (POSIX vs Windows).
// ---------------------------------------------------------------------------
export class Xa11yPlatform implements Platform {
  constructor(
    private readonly client: WorkerClient,
    readonly id: 'linux' | 'windows' | 'macos',
    /**
     * The worker's display server (`info.capabilities.display`): `x11`,
     * `wayland`, or '' when unknown. On a Wayland sandbox the xa11y screenshot
     * path (xdg-desktop-portal) is unavailable, so we capture with `grim`
     * instead — the AT-SPI tree/action/input paths are identical.
     */
    private readonly display: string = '',
  ) {}

  /** Temp path for a screenshot; the OS's native separator is irrelevant to
   *  xa11y (it accepts forward slashes on Windows too). */
  private shotPath(): string {
    return this.id === 'windows'
      ? 'C:/Windows/Temp/cu-shot.png'
      : '/tmp/cu-shot.png'
  }

  async probe(): Promise<void> {
    const res = await run(this.client, 'command -v xa11y', {
      timeoutMs: 10_000,
    })
    if (!isSettled(res.state) || res.stdout.trim() === '') {
      throw new Error('xa11y-not-found')
    }
  }

  async apps(): Promise<AppInfo[]> {
    const res = await runChecked(this.client, 'xa11y apps', {
      timeoutMs: 20_000,
    })
    return parseApps(res.stdout)
  }

  async snapshot(app: string, depth: number): Promise<string> {
    const appFlag = app === '' ? '' : ` --app ${shq(app)}`
    const depthFlag = depth > 0 ? ` --depth ${depth}` : ''
    const res = await runChecked(
      this.client,
      `xa11y tree${appFlag}${depthFlag}`,
      { timeoutMs: 30_000 },
    )
    return res.stdout
  }

  async find(selector: string, app: string, output: string): Promise<string> {
    const appFlag = app === '' ? '' : ` --app ${shq(app)}`
    const fmt = output === '' ? 'pretty' : output
    const res = await run(
      this.client,
      `xa11y find ${shq(selector)}${appFlag} -o ${fmt}`,
      { timeoutMs: 30_000 },
    )
    // xa11y exits non-zero with a "no elements matched" message.
    return res.stdout
  }

  async action(
    action: string,
    target: string,
    value: string,
    app: string,
  ): Promise<void> {
    const appFlag = app === '' ? '' : ` --app ${shq(app)}`
    const valueFlag = value === '' ? '' : ` --value ${shq(value)}`
    await runChecked(
      this.client,
      `xa11y action ${shq(action)} ${shq(target)}${appFlag}${valueFlag}`,
      { timeoutMs: 30_000 },
    )
  }

  async click(
    x: number,
    y: number,
    button: string,
    count: number,
  ): Promise<void> {
    const btn = button === '' ? 'left' : button
    const cnt = count < 1 ? 1 : count
    await runChecked(
      this.client,
      `xa11y click --at ${coord(x)},${coord(y)} --button ${shq(btn)} --count ${cnt}`,
      { timeoutMs: 20_000 },
    )
  }

  async typeText(text: string, target: string): Promise<void> {
    // Focus the target first when one is given.
    if (target !== '') {
      await runChecked(this.client, `xa11y action focus ${shq(target)}`, {
        timeoutMs: 20_000,
      })
    }
    await runChecked(this.client, `xa11y type ${shq(text)}`, {
      timeoutMs: 20_000,
    })
  }

  async key(key: string, held: string[]): Promise<void> {
    const heldFlag = held.length > 0 ? ` --held ${shq(held.join(','))}` : ''
    await runChecked(this.client, `xa11y key ${shq(key)}${heldFlag}`, {
      timeoutMs: 20_000,
    })
  }

  async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
    await runChecked(
      this.client,
      `xa11y scroll --at ${coord(x)},${coord(y)} --dx ${coord(dx)} --dy ${coord(dy)}`,
      { timeoutMs: 20_000 },
    )
  }

  async drag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    durationMs: number,
  ): Promise<void> {
    const dur = durationMs > 0 ? ` --duration-ms ${Math.round(durationMs)}` : ''
    await runChecked(
      this.client,
      `xa11y drag --from ${coord(fromX)},${coord(fromY)} --to ${coord(toX)},${coord(toY)}${dur}`,
      { timeoutMs: 30_000 },
    )
  }

  async screenshot(
    region: string,
  ): Promise<{ path: string; width: number; height: number }> {
    const path = this.shotPath()
    const regionFlag = region === '' ? '' : ` --region ${shq(region)}`
    // Wayland (e.g. the labwc desktop image): xa11y's screenshot uses
    // xdg-desktop-portal, which a headless compositor does not provide. Capture
    // the compositor output with grim instead (the image ships it).
    if (this.display === 'wayland' && this.id === 'linux') {
      const grimCmd =
        region === ''
          ? `grim ${path} || grim -o "$(wlr-randr --json 2>/dev/null | sed -n 's/.*"name": *"\\([^"]*\\)".*/\\1/p' | head -1)" ${path}`
          : `grim -g ${shq(region)} ${path}`
      const gres = await runChecked(this.client, grimCmd, { timeoutMs: 30_000 })
      const m = gres.stdout.match(/(\d+)\s*x\s*(\d+)/)
      return {
        path,
        width: m !== null ? Number(m[1]) : 0,
        height: m !== null ? Number(m[2]) : 0,
      }
    }
    const res = await runChecked(
      this.client,
      `xa11y screenshot${regionFlag} --out ${path}`,
      { timeoutMs: 30_000 },
    )
    // xa11y prints `wrote PATH (WxH @Nx)`; parse it when present.
    const m = res.stdout.match(/\((\d+)x(\d+)/)
    return {
      path,
      width: m !== null ? Number(m[1]) : 0,
      height: m !== null ? Number(m[2]) : 0,
    }
  }
}

// ---------------------------------------------------------------------------
// Android via adb + uiautomator
// ---------------------------------------------------------------------------
export class AndroidPlatform implements Platform {
  readonly id = 'android' as const
  private static readonly SERIAL = 'emulator-5554'

  constructor(private readonly client: WorkerClient) {}

  private adb(
    sub: string,
    timeoutMs = 20_000,
  ): Promise<{ stdout: string; state: string; exitCode: number }> {
    return runChecked(this.client, `adb -s ${AndroidPlatform.SERIAL} ${sub}`, {
      timeoutMs,
    })
  }

  async probe(): Promise<void> {
    // The emulator boots in the background; the caller should wait for it.
    const res = await run(
      this.client,
      `adb -s ${AndroidPlatform.SERIAL} wait-for-device shell getprop sys.boot_completed`,
      { timeoutMs: 120_000 },
    )
    if (!isSettled(res.state) || !res.stdout.includes('1')) {
      throw new Error('android-emulator-not-ready')
    }
  }

  async apps(): Promise<AppInfo[]> {
    // Foreground package/activity via dumpsys (uiautomator has no app list).
    const res = await this.adb(
      'shell "dumpsys window 2>/dev/null | grep -E mCurrentFocus"',
    )
    const line = res.stdout.trim()
    const m = line.match(/([a-zA-Z0-9_.]+)\/([a-zA-Z0-9_.]+)/)
    if (m === null) return []
    return [{ pid: '', name: `${m[1]}/${m[2]}`, focused: true }]
  }

  async snapshot(_app: string, _depth: number): Promise<string> {
    // `uiautomator dump` writes XML to the device; read it back as text.
    const res = await this.adb(
      'shell "uiautomator dump /sdcard/cu-ui.xml >/dev/null 2>&1 && cat /sdcard/cu-ui.xml"',
    )
    return res.stdout
  }

  async find(selector: string, _app: string, output: string): Promise<string> {
    // No CSS selectors on Android: match by resource-id/text substring.
    const res = await this.adb(
      `shell "uiautomator dump /sdcard/cu-ui.xml >/dev/null 2>&1 && cat /sdcard/cu-ui.xml"`,
    )
    const xml = res.stdout
    const hits: string[] = []
    const re = /<node[^>]*>/g
    for (const node of xml.match(re) ?? []) {
      if (
        xml !== '' &&
        (node.includes(`text="${selector}"`) ||
          node.includes(`resource-id="${selector}"`) ||
          (selector !== '' &&
            (extract(node, 'text')?.includes(selector) ?? false)) ||
          (selector !== '' &&
            (extract(node, 'resource-id')?.includes(selector) ?? false)))
      ) {
        const bounds = extract(node, 'bounds') ?? ''
        hits.push(
          output === 'bounds' || output === 'center'
            ? bounds
            : `${extract(node, 'class') ?? '?'} text=${JSON.stringify(extract(node, 'text') ?? '')} ${bounds}`,
        )
      }
    }
    return hits.length > 0 ? hits.join('\n') : ''
  }

  async action(
    action: string,
    target: string,
    value: string,
    _app: string,
  ): Promise<void> {
    // Map a few actions to adb. `press` -> tap center of the target bounds.
    if (action === 'press') {
      const center = await this.centerOf(target)
      if (center === null)
        throw new Error(`could not resolve target: ${target}`)
      await this.click(center[0], center[1], 'left', 1)
      return
    }
    if (action === 'set-value' || action === 'type-text') {
      await this.typeText(value, target)
      return
    }
    if (action === 'focus') return
    if (action === 'scroll-into-view') {
      await this.scroll(540, 960, 0, 300)
      return
    }
    throw new Error(`action ${action} is not supported on Android`)
  }

  /** Resolve a `[x,y][x,y]` bounds string or an XML selector to a center. */
  private async centerOf(target: string): Promise<[number, number] | null> {
    if (/^\[\d+,\d+\]\[\d+,\d+\]$/.test(target)) {
      const b = parseBounds(target)
      return b === null
        ? null
        : [Math.round((b[0] + b[2]) / 2), Math.round((b[1] + b[3]) / 2)]
    }
    const res = await this.adb(
      `shell "uiautomator dump /sdcard/cu-ui.xml >/dev/null 2>&1 && cat /sdcard/cu-ui.xml"`,
    )
    for (const node of res.stdout.match(/<node[^>]*>/g) ?? []) {
      if (
        node.includes(`text="${target}"`) ||
        node.includes(`resource-id="${target}"`)
      ) {
        const b = parseBounds(extract(node, 'bounds') ?? '')
        if (b !== null) {
          return [Math.round((b[0] + b[2]) / 2), Math.round((b[1] + b[3]) / 2)]
        }
      }
    }
    return null
  }

  async click(
    x: number,
    y: number,
    _button: string,
    _count: number,
  ): Promise<void> {
    await this.adb(`shell input tap ${coord(x)} ${coord(y)}`)
  }

  async typeText(text: string, target: string): Promise<void> {
    if (target !== '') {
      const c = await this.centerOf(target)
      if (c !== null) await this.click(c[0], c[1], 'left', 1)
    }
    // adb `input text` uses %s for spaces and cannot send some chars.
    await this.adb(`shell input text ${shq(text.replace(/ /g, '%s'))}`)
  }

  async key(key: string, _held: string[]): Promise<void> {
    const code = keyCode(key)
    await this.adb(`shell input keyevent ${code}`)
  }

  async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
    // Emulate a swipe; dy>0 scrolls content down (swipe up).
    const dist = Math.max(50, Math.abs(dy || dx))
    const sx = coord(x)
    const sy = coord(y)
    const ex = dx !== 0 ? coord(x - Math.sign(dx) * dist) : sx
    const ey = dy !== 0 ? coord(y - Math.sign(dy) * dist) : sy
    await this.adb(`shell input swipe ${sx} ${sy} ${ex} ${ey} 300`)
  }

  async drag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    durationMs: number,
  ): Promise<void> {
    const dur = durationMs > 0 ? Math.round(durationMs) : 300
    await this.adb(
      `shell input swipe ${coord(fromX)} ${coord(fromY)} ${coord(toX)} ${coord(toY)} ${dur}`,
    )
  }

  async screenshot(
    _region: string,
  ): Promise<{ path: string; width: number; height: number }> {
    const path = '/tmp/cu-shot.png'
    await this.adb(`exec-out screencap -p > ${path}`, 30_000)
    return { path, width: 0, height: 0 }
  }
}

function extract(node: string, attr: string): string | undefined {
  const m = node.match(new RegExp(`${attr}="([^"]*)"`))
  return m?.[1]
}

function parseBounds(s: string): [number, number, number, number] | null {
  const m = s.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/)
  if (m === null) return null
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
}

/** Map a few key names to Android keycodes (extend as needed). */
function keyCode(key: string): string {
  const k = key.toLowerCase()
  const map: Record<string, number> = {
    return: 66,
    enter: 66,
    back: 4,
    home: 3,
    menu: 82,
    tab: 61,
    escape: 111,
    delete: 67,
    up: 19,
    down: 20,
    left: 21,
    right: 22,
  }
  return String(map[k] ?? 66)
}

/** Single-quote for shell interpolation (mirrors exec.shq). */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
