# Markdown formatting tour

A quick tour of what Folio renders — open this file to see the preview, then toggle
**Source Code Mode** (`Ctrl/Cmd + /`) to see the Markdown behind it.

## Text & inline formatting

You get the usual Markdown: **bold**, *italic*, ~~strikethrough~~, `inline code`,
[links](https://github.com/dpokluda/Folio), and footnotes.[^1]

## Lists

- Bullet lists
  - with nesting
- and more items

1. Ordered lists
2. count
3. automatically

### Task lists

- [x] Render Markdown into `#write`
- [x] Themeable CodeMirror source editor under `#typora-source`
- [ ] Add your own Typora themes

## Tables

| Feature        | Preview | Source mode |
| -------------- | :-----: | :---------: |
| Themeable      |   ✅    |     ✅      |
| Syntax colours |   ✅    |     ✅      |
| Export to PDF  |   ✅    |     —       |

## Code

```js
// Fenced code is highlighted with highlight.js in the preview.
function greet(name) {
  return `Hello, ${name}! Welcome to Folio.`;
}

console.log(greet('world'));
```

```python
def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
```

## Blockquote

> "Simplicity is the ultimate sophistication."
>
> Themes control the page, the type, and the source editor — Folio just wires it together.

## Emoji

Ship it :rocket:  ·  Looks good :sparkles:  ·  Coffee first :coffee:

---

Folio is **not affiliated with, endorsed by, or sponsored by the Typora team**.
"Typora" is a trademark of its respective owner and is referenced here solely to describe
theme compatibility.

[^1]: Footnotes work too — handy for references and asides.
