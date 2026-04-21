import { mount } from 'svelte';
import App from './app.svelte';

const target = document.getElementById('root');
if (!target) throw new Error('No #root element');
mount(App, { target });
