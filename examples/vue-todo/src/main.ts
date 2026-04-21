import { createApp } from 'vue';
import App from './app.vue';

const root = document.getElementById('root');
if (!root) throw new Error('No #root element');
createApp(App).mount(root);
