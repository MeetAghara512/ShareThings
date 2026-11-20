import './App.css';
import { Routes, Route } from 'react-router-dom';
import Lobby from './Pages/Lobby';
import Room from './Pages/Room';
import { useState } from 'react';
import { AuthProvider } from './useContext/AuthProvider';

function App() {
	const [darkMode, setDarkMode] = useState(true);

	const toggleDarkMode = () => setDarkMode(prev => !prev);

	return (
		<div className={`min-h-[100vh] transition-colors duration-700 ease-in-out ${darkMode
				? "dark bg-gray-900 text-gray-100"
				: "bg-white text-gray-900"
			}`}>
			<AuthProvider>
			<Routes>
				<Route path='/' element={<Lobby darkMode={darkMode} toggleDarkMode={toggleDarkMode} />} />
				<Route path='/room/:roomId' element={<Room darkMode={darkMode} toggleDarkMode={toggleDarkMode} />} />
			</Routes>
			</AuthProvider>
		</div>
	);
}

export default App;
