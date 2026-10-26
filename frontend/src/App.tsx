import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { AdminRestaurantsPage } from './admin/AdminRestaurantsPage';
import { UsersPage } from './admin/UsersPage';
import { Layout } from './components/Layout';
import { DeliveriesPage } from './delivery/DeliveriesPage';
import { DeliveryPage } from './delivery/DeliveryPage';
import { OrderPage } from './customer/OrderPage';
import { OrdersPage } from './customer/OrdersPage';
import { RestaurantPage } from './customer/RestaurantPage';
import { RestaurantsPage } from './customer/RestaurantsPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProfilePage } from './pages/ProfilePage';
import { RegisterPage } from './pages/RegisterPage';
import { ManageRestaurantPage } from './restaurant/ManageRestaurantPage';
import { MyRestaurantsPage } from './restaurant/MyRestaurantsPage';
import { RestaurantOrderPage } from './restaurant/RestaurantOrderPage';
import { homeFor } from './routes';

function Home() {
  const { role } = useAuth();
  return <Navigate to={homeFor(role)} replace />;
}

/** All routes in one place. Each role's area is guarded by ProtectedRoute; the backend still authorizes every call. */
export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="login" element={<LoginPage />} />
            <Route path="register" element={<RegisterPage />} />

            <Route element={<ProtectedRoute />}>
              <Route path="profile" element={<ProfilePage />} />
            </Route>

            <Route element={<ProtectedRoute roles={['customer']} />}>
              <Route path="restaurants" element={<RestaurantsPage />} />
              <Route path="restaurants/:id" element={<RestaurantPage />} />
              <Route path="orders" element={<OrdersPage />} />
              <Route path="orders/:id" element={<OrderPage />} />
            </Route>

            <Route element={<ProtectedRoute roles={['restaurant_admin']} />}>
              <Route path="manage" element={<MyRestaurantsPage />} />
              <Route path="manage/:id" element={<ManageRestaurantPage />} />
              <Route path="manage/orders/:orderId" element={<RestaurantOrderPage />} />
            </Route>

            <Route element={<ProtectedRoute roles={['delivery_agent']} />}>
              <Route path="deliveries" element={<DeliveriesPage />} />
              <Route path="deliveries/:id" element={<DeliveryPage />} />
            </Route>

            <Route element={<ProtectedRoute roles={['platform_admin']} />}>
              <Route path="admin/users" element={<UsersPage />} />
              <Route path="admin/restaurants" element={<AdminRestaurantsPage />} />
            </Route>

            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
