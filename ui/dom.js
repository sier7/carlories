/** 极简 DOM 构造helper。不引入框架：这个应用不需要，且少一层依赖就少一处将来换壳时的包袱。 */

export function h(tag, props, ...children) {
  const node = document.createElement(tag)

  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue
      if (key === 'class') node.className = value
      else if (key === 'dataset') Object.assign(node.dataset, value)
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value)
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value)
      } else if (key === 'value') node.value = value
      else if (key === 'checked' || key === 'disabled') node[key] = Boolean(value)
      else node.setAttribute(key, value === true ? '' : String(value))
    }
  }

  appendChildren(node, children)
  return node
}

export function appendChildren(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
  return node
}

export function mount(parent, ...children) {
  clear(parent)
  appendChildren(parent, children)
  return parent
}
