import { RouteObject } from 'react-router-dom';

const HomePage = () => import('../pages/Home');
const CreatePage = () => import('../pages/Create');
const JoinPage = () => import('../pages/Join');
const DownloadPage = () => import('../pages/Download');
const RoomPage = () => import('../pages/Room');
const ListenPage = () => import('../pages/Listen');
const ContactPage = () => import('../pages/Contact');

export const applicationRoutes: RouteObject[] = [
  // Main page
  { path: '/', lazy: HomePage },
  { path: '/create', lazy: CreatePage },
  { path: '/join', lazy: JoinPage },
  { path: '/download', lazy: DownloadPage },
  { path: '/:room', lazy: RoomPage },
  { path: '/listen/:room', lazy: ListenPage },
  { path: '/contact', lazy: ContactPage },
];
