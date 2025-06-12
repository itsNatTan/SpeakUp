import { roomsApi } from '@api/client';
import { useEffect, useState } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { applicationRoutes } from './routes/routes';
import stores from './stores';

const router = createBrowserRouter(applicationRoutes);

const App: React.FC = () => {
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const recentRooms = stores.rooms.getRecentRooms();
    Promise.all(recentRooms.map((room) => roomsApi.getCooldown(room)))
      .then((cooldowns) => {
        const nonExpiredRooms = recentRooms.filter((_, i) => cooldowns[i]! > 0);
        stores.rooms.setRecentRooms(nonExpiredRooms);
        setIsLoading(false);
      })
      .catch(() => setIsLoading(false));
  }, []);
  if (isLoading) {
    return <div>Loading&hellip;</div>;
  }

  return <RouterProvider router={router} />;
};

export default App;
