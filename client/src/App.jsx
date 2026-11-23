import './App.css';
import { Routes, Route } from 'react-router-dom';
import Lobby from './Pages/Lobby';
import Room from './Pages/Room';
import Left from './Pages/Left';
import { useState } from 'react';
import { AuthProvider } from './useContext/AuthProvider';
import VersionBanner from './Pages/VersionBanner';

const THEME_KEY = "sharethings.theme";

function App() {
	const [darkMode, setDarkMode] = useState(() => localStorage.getItem(THEME_KEY) !== "light");

	const toggleDarkMode = () => {
		localStorage.setItem(THEME_KEY, darkMode ? "light" : "dark");
		setDarkMode(!darkMode);
	};

	return (
		<div className={`min-h-[100vh] transition-colors duration-700 ease-in-out ${darkMode
				? "dark bg-gray-900 text-gray-100"
				: "bg-white text-gray-900"
			}`}>
			<VersionBanner />
			<AuthProvider>
			<Routes>
				<Route path='/' element={<Lobby darkMode={darkMode} toggleDarkMode={toggleDarkMode} />} />
				<Route path='/room/:roomId' element={<Room darkMode={darkMode} toggleDarkMode={toggleDarkMode} />} />
				<Route path='/left/:roomId' element={<Left darkMode={darkMode} />} />
			</Routes>
			</AuthProvider>
		</div>
	);
}

export default App;
