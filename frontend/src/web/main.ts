import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createWebHistory } from 'vue-router'
import App from './App.vue'
import { createAppRouter } from './router'
import { installHttpHooks } from './setup'
import './styles.css'

const pinia = createPinia()
const router = createAppRouter(createWebHistory(), pinia)
installHttpHooks(router, pinia)

const app = createApp(App)
app.use(pinia).use(router)
// Wait for the initial navigation (guard included) before mounting: the
// first paint is the settled screen, never an in-between frame of the
// shell / public layout racing the session check (TASK-39 A-1).
void router.isReady().then(() => app.mount('#app'))
