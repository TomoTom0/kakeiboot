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

createApp(App).use(pinia).use(router).mount('#app')
