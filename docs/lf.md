# lf keybindings

Default keybindings for the [`lf`](https://github.com/gokcehan/lf) terminal file manager.
Source: `lf -doc`.

## Custom mappings
Defined in [`../lf/lfrc`](../lf/lfrc) (symlinked to `~/.config/lf/lfrc`):

| Key | Action | Notes |
|-----|--------|-------|
| `x` | delete | `delete` is unbound by default since it's destructive |

`rename` is left on its default `r` binding.

Everything below is the stock default set.

## Navigation
| Key | Action |
|-----|--------|
| `k` / `↑` | up |
| `j` / `↓` | down |
| `h` / `←` | updir (go to parent) |
| `l` / `→` | open (enter dir / open file) |
| `<c-u>` | half page up |
| `<c-d>` | half page down |
| `<c-b>` / `<pgup>` | page up |
| `<c-f>` / `<pgdn>` | page down |
| `<c-y>` | scroll up (keep cursor) |
| `<c-e>` | scroll down (keep cursor) |
| `gg` / `<home>` | top |
| `G` / `<end>` | bottom |
| `H` | high (top of screen) |
| `M` | middle of screen |
| `L` | low (bottom of screen) |
| `[` | jump-prev |
| `]` | jump-next |

## Selection
| Key | Action |
|-----|--------|
| `<space>` | toggle (select current, move down)* |
| `v` | invert selection |
| `u` | unselect all |
| `V` | enter visual mode |

\*`toggle` has no default key in the doc's reference but is conventionally `<space>` — bind it yourself if needed.

## File operations
| Key | Action |
|-----|--------|
| `y` | copy (yank) |
| `d` | cut |
| `p` | paste |
| `c` | clear copy/cut buffer |
| `<delete>` | delete (modal — no default key, bind it) |
| `r` | rename (modal) |
| `<c-r>` | reload |
| `<c-l>` | redraw |

## Find / search
| Key | Action |
|-----|--------|
| `f` | find (forward) |
| `F` | find-back |
| `;` | find-next |
| `,` | find-prev |
| `/` | search |
| `?` | search-back |
| `n` | search-next |
| `N` | search-prev |

## Marks & tags
| Key | Action |
|-----|--------|
| `m` | mark-save |
| `'` | mark-load |
| `"` | mark-remove |
| `t` | tag-toggle |

## Shell & commands
| Key | Action |
|-----|--------|
| `:` | read (enter a command) |
| `$` | shell |
| `%` | shell-pipe |
| `!` | shell-wait |
| `&` | shell-async |

## Misc
| Key | Action |
|-----|--------|
| `q` | quit |
| `<f-1>` | help (doc in pager) |

## Visual mode
| Key | Action |
|-----|--------|
| `V` | visual-accept |
| `o` | visual-change |
| `<esc>` | visual-discard |

## Command-line mode (while typing in the prompt)
| Key | Action |
|-----|--------|
| `<esc>` | cmd-escape |
| `<tab>` | cmd-complete |
| `<c-j>` / `<enter>` | cmd-enter (submit) |
| `<c-c>` | cmd-interrupt |
| `<c-n>` / `<down>` | cmd-history-next |
| `<c-p>` / `<up>` | cmd-history-prev |
| `<c-b>` / `<left>` | cmd-left |
| `<c-f>` / `<right>` | cmd-right |
| `<c-a>` / `<home>` | cmd-home |
| `<c-e>` / `<end>` | cmd-end |
| `<c-d>` / `<delete>` | cmd-delete |
| `<backspace>` | cmd-delete-back |
| `<c-u>` | cmd-delete-home |
| `<c-k>` | cmd-delete-end |
| `<c-w>` | cmd-delete-unix-word |
| `<c-y>` | cmd-yank |
| `<c-t>` | cmd-transpose |
| `<a-t>` | cmd-transpose-word |
| `<a-f>` | cmd-word (forward) |
| `<a-b>` | cmd-word-back |
| `<a-d>` | cmd-delete-word |
| `<a-backspace>` | cmd-delete-word-back |
| `<a-c>` | cmd-capitalize-word |
| `<a-u>` | cmd-uppercase-word |
| `<a-l>` | cmd-lowercase-word |
