import { EventEmitter } from 'events'

export const notifEmitter = new EventEmitter()
notifEmitter.setMaxListeners(2000)
