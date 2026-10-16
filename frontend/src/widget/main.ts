import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './style.css'
import { applyTheme, resolveHost } from './host'
import { useWidgetStore } from './stores/widget'

async function start() {
  const host = await resolveHost()
  const pinia = createPinia()
  const app = createApp(App).use(pinia)
  const store = useWidgetStore(pinia)
  applyTheme(host)
  store.init(host)
  // toolOutput / theme can arrive after the first render (openai:set_globals).
  host.onGlobalsChange(() => {
    applyTheme(host)
    if (!store.screen && host.toolOutput()) store.init(host)
  })
  app.mount('#app')
}

void start()
