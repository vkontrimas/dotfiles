vim.cmd [[packadd packer.nvim]]

return require('packer').startup(function()
  use 'wbthomason/packer.nvim'
  -- use 'ayu-theme/ayu-vim'
  use 'shatur/neovim-ayu'
  use 'tpope/vim-surround'
  use 'junegunn/fzf.vim'
  use 'junegunn/fzf'
  use {'nvim-treesitter/nvim-treesitter', run = ':TSUpdate'}
end)
