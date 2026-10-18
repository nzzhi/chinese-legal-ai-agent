import { Socket } from 'node:net'
const connect = Socket.prototype.connect
const local = host => ['localhost','127.0.0.1','::1','[::1]'].includes(host)
Socket.prototype.connect = function (...args) {
  const option = args[0], host = typeof option === 'object' ? option.host : typeof args[1] === 'string' ? args[1] : undefined
  if (host && !local(host)) throw new Error('OFFLINE external socket refused')
  return connect.apply(this,args)
}
const networkFetch = globalThis.fetch
globalThis.fetch = (input,init) => {
  if (!local(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname)) throw new Error('OFFLINE external fetch refused')
  return networkFetch(input,init)
}
